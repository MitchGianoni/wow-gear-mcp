import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

const VERSION = "1.1.0";
const PORT = Number.parseInt(process.env.PORT ?? "3000", 10);
const DEFAULT_REGION = (process.env.WOW_REGION ?? "us").trim().toLowerCase();
const DEFAULT_REALM = (process.env.WOW_REALM ?? "stormrage").trim();
const DEFAULT_CHARACTER = (process.env.WOW_CHARACTER ?? "zandenx").trim();
const CACHE_TTL_MS = Number.parseInt(process.env.RAIDERIO_CACHE_TTL_MS ?? "30000", 10);

const cache = new Map();

function buildAllowedHosts() {
  const hosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

  for (const host of (process.env.ALLOWED_HOSTS ?? "").split(",")) {
    const trimmed = host.trim();
    if (trimmed) hosts.add(trimmed);
  }

  const renderHost = (process.env.RENDER_EXTERNAL_HOSTNAME ?? "").trim();
  if (renderHost) hosts.add(renderHost);

  return [...hosts];
}

function numberOrNull(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function stringOrNull(value) {
  if (typeof value === "string" && value.trim()) return value;
  if (value && typeof value === "object") {
    for (const key of ["name", "type", "display_string", "displayString", "en_US"]) {
      if (typeof value[key] === "string" && value[key].trim()) return value[key];
    }
  }
  return null;
}

function normalizeItem(slot, item) {
  const nestedItem = item?.item && typeof item.item === "object" ? item.item : {};
  const level = item?.item_level ?? item?.itemLevel ?? item?.level?.value ?? item?.level;
  const name =
    item?.item_name ??
    item?.name ??
    nestedItem?.name?.en_US ??
    nestedItem?.name ??
    null;
  const id = item?.item_id ?? item?.id ?? nestedItem?.id ?? null;

  return {
    slot: String(slot),
    name: stringOrNull(name),
    itemId: numberOrNull(id),
    itemLevel: numberOrNull(level),
    quality: stringOrNull(item?.quality ?? nestedItem?.quality),
    icon: stringOrNull(item?.icon ?? nestedItem?.icon),
    itemLink: stringOrNull(item?.item_link ?? item?.itemLink),
  };
}

function normalizeItems(gear) {
  const rawItems = gear?.items;
  if (!rawItems) return [];

  if (Array.isArray(rawItems)) {
    return rawItems.map((item, index) =>
      normalizeItem(item?.slot ?? item?.slot_name ?? `slot_${index + 1}`, item),
    );
  }

  if (typeof rawItems === "object") {
    return Object.entries(rawItems).map(([slot, item]) => normalizeItem(slot, item));
  }

  return [];
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function resolveCharacter(args = {}) {
  const suppliedCharacter = nonEmptyString(args.character);
  const suppliedRealm = nonEmptyString(args.realm);

  if ((suppliedCharacter && !suppliedRealm) || (!suppliedCharacter && suppliedRealm)) {
    throw new Error(
      "For a non-default character lookup, provide both character and realm. Region is optional and defaults to the configured region.",
    );
  }

  return {
    region: (nonEmptyString(args.region) ?? DEFAULT_REGION).toLowerCase(),
    realm: suppliedRealm ?? DEFAULT_REALM,
    character: suppliedCharacter ?? DEFAULT_CHARACTER,
  };
}

function characterSourceUrl(profile, identity) {
  if (typeof profile?.profile_url === "string" && profile.profile_url) return profile.profile_url;

  const region = (stringOrNull(profile?.region) ?? identity.region).toLowerCase();
  const realm = stringOrNull(profile?.realm) ?? identity.realm;
  const character = stringOrNull(profile?.name) ?? identity.character;
  const realmSlug = encodeURIComponent(realm.toLowerCase().replaceAll(" ", "-"));
  const characterSlug = encodeURIComponent(character.toLowerCase());

  return `https://raider.io/characters/${encodeURIComponent(region)}/${realmSlug}/${characterSlug}`;
}

async function fetchRaiderIO(fields, identity) {
  const fieldString = fields.join(",");
  const cacheKey = [
    identity.region.toLowerCase(),
    identity.realm.toLowerCase(),
    identity.character.toLowerCase(),
    fieldString,
  ].join("|");
  const now = Date.now();
  const cached = cache.get(cacheKey);

  if (cached && now - cached.storedAt < CACHE_TTL_MS) {
    return { data: cached.data, cacheHit: true };
  }

  const url = new URL("https://raider.io/api/v1/characters/profile");
  url.searchParams.set("region", identity.region);
  url.searchParams.set("realm", identity.realm);
  url.searchParams.set("name", identity.character);
  if (fieldString) url.searchParams.set("fields", fieldString);

  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": `wow-gear-mcp/${VERSION} (personal read-only MCP)`,
    },
    signal: AbortSignal.timeout(12_000),
  });

  if (!response.ok) {
    const retryAfter = response.headers.get("retry-after");
    let detail = "";
    try {
      detail = (await response.text()).slice(0, 500);
    } catch {
      // Ignore secondary response parsing errors.
    }
    const suffix = retryAfter ? ` Retry-After: ${retryAfter}s.` : "";
    throw new Error(
      `Raider.IO returned HTTP ${response.status} for ${identity.region}/${identity.realm}/${identity.character}.${suffix}${detail ? ` ${detail}` : ""}`,
    );
  }

  const data = await response.json();
  cache.set(cacheKey, { data, storedAt: now });
  return { data, cacheHit: false };
}

const characterLookupSchema = z.object({
  character: z
    .string()
    .optional()
    .describe(
      `Character name. Omit together with realm to use the configured default (${DEFAULT_CHARACTER}-${DEFAULT_REALM}).`,
    ),
  realm: z
    .string()
    .optional()
    .describe(
      `Realm name for the requested character. Provide together with character. Omit both to use ${DEFAULT_REALM}.`,
    ),
  region: z
    .string()
    .optional()
    .describe(`WoW region such as us, eu, kr, or tw. Defaults to ${DEFAULT_REGION}.`),
});

const gearItemSchema = z.object({
  slot: z.string(),
  name: z.string().nullable(),
  itemId: z.number().nullable(),
  itemLevel: z.number().nullable(),
  quality: z.string().nullable(),
  icon: z.string().nullable(),
  itemLink: z.string().nullable(),
});

const gearSummarySchema = z.object({
  name: z.string(),
  realm: z.string(),
  region: z.string(),
  className: z.string().nullable(),
  race: z.string().nullable(),
  faction: z.string().nullable(),
  activeSpec: z.string().nullable(),
  activeRole: z.string().nullable(),
  equippedItemLevel: z.number().nullable(),
  totalItemLevel: z.number().nullable(),
  lastCrawledAt: z.string().nullable(),
  gearUpdatedAt: z.string().nullable(),
  fetchedAt: z.string(),
  cacheHit: z.boolean(),
  sourceUrl: z.string(),
  items: z.array(gearItemSchema),
});

function summarizeGear(profile, cacheHit, identity) {
  const gear = profile?.gear ?? {};
  return {
    name: String(profile?.name ?? identity.character),
    realm: String(profile?.realm ?? identity.realm),
    region: String(profile?.region ?? identity.region),
    className: stringOrNull(profile?.class),
    race: stringOrNull(profile?.race),
    faction: stringOrNull(profile?.faction),
    activeSpec: stringOrNull(profile?.active_spec_name),
    activeRole: stringOrNull(profile?.active_spec_role),
    equippedItemLevel: numberOrNull(gear?.item_level_equipped ?? gear?.equipped_item_level),
    totalItemLevel: numberOrNull(gear?.item_level_total ?? gear?.total_item_level),
    lastCrawledAt: stringOrNull(profile?.last_crawled_at),
    gearUpdatedAt: stringOrNull(gear?.updated_at),
    fetchedAt: new Date().toISOString(),
    cacheHit,
    sourceUrl: characterSourceUrl(profile, identity),
    items: normalizeItems(gear),
  };
}

function gearText(summary) {
  const identity = [summary.name, summary.realm, summary.region.toUpperCase()].join(" - ");
  const spec = [summary.activeSpec, summary.className].filter(Boolean).join(" ");
  const ilvl = summary.equippedItemLevel ?? "unknown";
  const lines = summary.items
    .filter((item) => item.name || item.itemLevel)
    .sort((a, b) => a.slot.localeCompare(b.slot))
    .map(
      (item) =>
        `${item.slot}: ${item.name ?? `item ${item.itemId ?? "?"}`} (${item.itemLevel ?? "?"})`,
    );

  return [
    `${identity}${spec ? ` - ${spec}` : ""} - equipped ilvl ${ilvl}.`,
    `Raider.IO crawl: ${summary.lastCrawledAt ?? "unknown"}; gear update: ${summary.gearUpdatedAt ?? "unknown"}; fetched: ${summary.fetchedAt}.`,
    `Source: ${summary.sourceUrl}`,
    ...lines,
  ].join("\n");
}

function createServer() {
  const server = new McpServer({
    name: "WoW Raider.IO Character Lookup",
    version: VERSION,
    websiteUrl: "https://github.com/MitchGianoni/wow-gear-mcp",
  });

  server.registerTool(
    "get_character_gear",
    {
      title: "Get a WoW character's current gear",
      description:
        `Use this whenever the user asks about currently equipped WoW gear, item level, weakest gear slots, weapon/shield status, or what gear to target next for a public Raider.IO character. ` +
        `If the user means the configured default character (${DEFAULT_CHARACTER}-${DEFAULT_REALM}-${DEFAULT_REGION}), omit all inputs. ` +
        "For any other character, provide both character and realm; provide region when known. Returns Raider.IO freshness timestamps and does not modify the character or account.",
      inputSchema: characterLookupSchema,
      outputSchema: gearSummarySchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
    },
    async (args = {}) => {
      const identity = resolveCharacter(args);
      const { data, cacheHit } = await fetchRaiderIO(["gear"], identity);
      const summary = summarizeGear(data, cacheHit, identity);
      return {
        structuredContent: summary,
        content: [{ type: "text", text: gearText(summary) }],
      };
    },
  );

  server.registerTool(
    "get_character_profile",
    {
      title: "Get a WoW character's current Raider.IO profile",
      description:
        `Use this for broader current-state WoW questions that need gear plus talents, raid progression, Mythic+ score, or recent Mythic+ runs for a public Raider.IO character. ` +
        `If the user means the configured default character (${DEFAULT_CHARACTER}-${DEFAULT_REALM}-${DEFAULT_REGION}), omit all inputs. ` +
        "For any other character, provide both character and realm; provide region when known. Raider.IO data may lag the game, so check the returned crawl/update timestamps.",
      inputSchema: characterLookupSchema,
      outputSchema: z.object({
        gear: gearSummarySchema,
        talents: z.any().nullable(),
        raidProgression: z.record(z.string(), z.any()),
        mythicPlusScoresBySeason: z.array(z.any()),
        mythicPlusRecentRuns: z.array(z.any()),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
    },
    async (args = {}) => {
      const identity = resolveCharacter(args);
      const { data, cacheHit } = await fetchRaiderIO(
        [
          "gear",
          "talents",
          "raid_progression",
          "mythic_plus_scores_by_season:current",
          "mythic_plus_recent_runs",
        ],
        identity,
      );

      const result = {
        gear: summarizeGear(data, cacheHit, identity),
        talents: data?.talents ?? null,
        raidProgression:
          data?.raid_progression && typeof data.raid_progression === "object"
            ? data.raid_progression
            : {},
        mythicPlusScoresBySeason: Array.isArray(data?.mythic_plus_scores_by_season)
          ? data.mythic_plus_scores_by_season
          : [],
        mythicPlusRecentRuns: Array.isArray(data?.mythic_plus_recent_runs)
          ? data.mythic_plus_recent_runs
          : [],
      };

      return {
        structuredContent: result,
        content: [
          {
            type: "text",
            text: `${gearText(result.gear)}\nRaid progression, talents, current-season Mythic+ scores, and recent runs are included in structuredContent.`,
          },
        ],
      };
    },
  );

  return server;
}

const handler = createMcpHandler(createServer);
const allowedHosts = buildAllowedHosts();
const app = createMcpExpressApp({ host: "0.0.0.0", allowedHosts });
const nodeHandler = toNodeHandler(handler);

app.get("/", (_req, res) => {
  res.json({
    name: "WoW Raider.IO Character Lookup",
    version: VERSION,
    status: "ok",
    mcp: "/mcp",
    health: "/health",
    defaultCharacter: `${DEFAULT_REGION}/${DEFAULT_REALM}/${DEFAULT_CHARACTER}`,
    arbitraryCharacterLookup: true,
  });
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", version: VERSION });
});

app.all("/mcp", (req, res) => void nodeHandler(req, res, req.body));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`wow-gear-mcp ${VERSION} listening on port ${PORT}`);
  console.log(
    `Default character: ${DEFAULT_REGION}/${DEFAULT_REALM}/${DEFAULT_CHARACTER}`,
  );
  console.log("Arbitrary public Raider.IO character lookup: enabled");
  console.log(`Allowed hosts: ${allowedHosts.join(", ")}`);
});
