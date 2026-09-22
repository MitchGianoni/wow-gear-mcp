import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

const VERSION = "1.0.0";
const PORT = Number.parseInt(process.env.PORT ?? "3000", 10);
const REGION = (process.env.WOW_REGION ?? "us").trim().toLowerCase();
const REALM = (process.env.WOW_REALM ?? "stormrage").trim();
const CHARACTER = (process.env.WOW_CHARACTER ?? "zandenx").trim();
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

function characterSourceUrl(profile) {
  if (typeof profile?.profile_url === "string" && profile.profile_url) return profile.profile_url;
  const realmSlug = encodeURIComponent(REALM.toLowerCase().replaceAll(" ", "-"));
  const characterSlug = encodeURIComponent(CHARACTER.toLowerCase());
  return `https://raider.io/characters/${encodeURIComponent(REGION)}/${realmSlug}/${characterSlug}`;
}

async function fetchRaiderIO(fields) {
  const fieldString = fields.join(",");
  const cacheKey = `${REGION}|${REALM}|${CHARACTER}|${fieldString}`;
  const now = Date.now();
  const cached = cache.get(cacheKey);

  if (cached && now - cached.storedAt < CACHE_TTL_MS) {
    return { data: cached.data, cacheHit: true };
  }

  const url = new URL("https://raider.io/api/v1/characters/profile");
  url.searchParams.set("region", REGION);
  url.searchParams.set("realm", REALM);
  url.searchParams.set("name", CHARACTER);
  if (fieldString) url.searchParams.set("fields", fieldString);

  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "wow-gear-mcp/1.0 (personal read-only MCP)",
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
      `Raider.IO returned HTTP ${response.status}.${suffix}${detail ? ` ${detail}` : ""}`,
    );
  }

  const data = await response.json();
  cache.set(cacheKey, { data, storedAt: now });
  return { data, cacheHit: false };
}

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

function summarizeGear(profile, cacheHit) {
  const gear = profile?.gear ?? {};
  return {
    name: String(profile?.name ?? CHARACTER),
    realm: String(profile?.realm ?? REALM),
    region: String(profile?.region ?? REGION),
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
    sourceUrl: characterSourceUrl(profile),
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
    .map((item) => `${item.slot}: ${item.name ?? `item ${item.itemId ?? "?"}`} (${item.itemLevel ?? "?"})`);

  return [
    `${identity}${spec ? ` - ${spec}` : ""} - equipped ilvl ${ilvl}.`,
    `Raider.IO crawl: ${summary.lastCrawledAt ?? "unknown"}; gear update: ${summary.gearUpdatedAt ?? "unknown"}; fetched: ${summary.fetchedAt}.`,
    `Source: ${summary.sourceUrl}`,
    ...lines,
  ].join("\n");
}

function createServer() {
  const server = new McpServer({
    name: "Zandenx WoW Live Gear",
    version: VERSION,
    websiteUrl: "https://github.com/MitchGianoni/wow-gear-mcp",
  });

  server.registerTool(
    "get_character_gear",
    {
      title: "Get Zandenx's current gear",
      description:
        "Use this whenever the user asks about Zandenx's currently equipped WoW gear, item level, weakest gear slots, weapon/shield status, or what gear to target next. Reads the configured character's latest public Raider.IO gear snapshot and returns freshness timestamps. It does not modify the character or account.",
      inputSchema: z.object({}),
      outputSchema: gearSummarySchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
    },
    async () => {
      const { data, cacheHit } = await fetchRaiderIO(["gear"]);
      const summary = summarizeGear(data, cacheHit);
      return {
        structuredContent: summary,
        content: [{ type: "text", text: gearText(summary) }],
      };
    },
  );

  server.registerTool(
    "get_character_profile",
    {
      title: "Get Zandenx's current WoW profile",
      description:
        "Use this for broader current-state WoW questions about Zandenx that need gear plus talents, raid progression, Mythic+ score, or recent Mythic+ runs. The data is public Raider.IO data and may lag the game; check the returned crawl/update timestamps.",
      inputSchema: z.object({}),
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
    async () => {
      const { data, cacheHit } = await fetchRaiderIO([
        "gear",
        "talents",
        "raid_progression",
        "mythic_plus_scores_by_season:current",
        "mythic_plus_recent_runs",
      ]);

      const result = {
        gear: summarizeGear(data, cacheHit),
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
    name: "Zandenx WoW Live Gear",
    version: VERSION,
    status: "ok",
    mcp: "/mcp",
    health: "/health",
    character: `${REGION}/${REALM}/${CHARACTER}`,
  });
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", version: VERSION });
});

app.all("/mcp", (req, res) => void nodeHandler(req, res, req.body));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`wow-gear-mcp ${VERSION} listening on port ${PORT}`);
  console.log(`Configured character: ${REGION}/${REALM}/${CHARACTER}`);
  console.log(`Allowed hosts: ${allowedHosts.join(", ")}`);
});
