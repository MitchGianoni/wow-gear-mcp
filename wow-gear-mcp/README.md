# WoW Gear MCP

A small read-only MCP server for ChatGPT that fetches **Zandenx's current public World of Warcraft gear/profile data from Raider.IO**.

Default character:

- Region: **US**
- Realm: **Stormrage**
- Character: **Zandenx**

The defaults can be changed with environment variables.

## Tools

### `get_character_gear`

Use for questions about the currently equipped gear, including:

- equipped item level
- every equipped slot and item level
- active spec
- weak slots
- weapon/shield status
- what gear to target next
- Raider.IO crawl/update timestamps so stale data is visible

### `get_character_profile`

Returns the same gear snapshot plus available public:

- talents
- raid progression
- current-season Mythic+ score
- recent Mythic+ runs

## Freshness limitation

Raider.IO data is sourced from Blizzard/public tracking and **is not guaranteed to update immediately after an in-game gear change**. The gear tool returns `lastCrawledAt`, `gearUpdatedAt`, and `fetchedAt` so ChatGPT can decide whether the snapshot is fresh enough.

This v1 intentionally uses Raider.IO because it needs no Battle.net secret. A later version can add Blizzard OAuth or Raider.IO Live Tracking if faster updates are needed.

## Requirements

- Node.js 22+
- A public HTTPS host for direct ChatGPT developer-mode connection

## Run locally

```bash
npm install
npm start
```

Endpoints:

- Health: `http://localhost:3000/health`
- MCP: `http://localhost:3000/mcp`

Inspect locally:

```bash
npx @modelcontextprotocol/inspector@latest
```

Choose **Streamable HTTP** and enter:

```text
http://localhost:3000/mcp
```

## Deploy on Render

This repo includes `Dockerfile` and `render.yaml`.

1. In Render, choose **New → Blueprint**.
2. Connect this GitHub repository.
3. Deploy the `wow-gear-mcp` service from `render.yaml`.
4. Wait for the service to become healthy.
5. Open `https://YOUR-HOST/health`; it should return JSON with `"status":"ok"`.
6. Your MCP endpoint is `https://YOUR-HOST/mcp`.

The server automatically trusts Render's `RENDER_EXTERNAL_HOSTNAME`. If you later use a custom domain, add it to the optional comma-separated `ALLOWED_HOSTS` environment variable.

## Connect to ChatGPT

1. Open **Settings → Security & login** and enable **Developer mode**.
2. Go to **ChatGPT Plugins** and select **+**.
3. Enter a user-facing name such as **Zandenx WoW Live Gear**.
4. For the MCP server URL, enter your deployed URL including `/mcp`.
5. Authentication: **None** (this v1 only proxies public read-only data).
6. Confirm ChatGPT discovers:
   - `get_character_gear`
   - `get_character_profile`
7. Create/install the personal plugin.

Suggested description:

> Reads Zandenx's latest public WoW gear, talents, raid progress, and Mythic+ context from Raider.IO for gearing advice.

## Environment variables

```text
WOW_REGION=us
WOW_REALM=stormrage
WOW_CHARACTER=zandenx
PORT=3000
RAIDERIO_CACHE_TTL_MS=30000
ALLOWED_HOSTS=
```

## API behavior

The server calls Raider.IO's public character profile endpoint:

```text
GET https://raider.io/api/v1/characters/profile
```

Raider.IO allows unauthenticated personal/community API use subject to rate limits. The server keeps a short 30-second in-memory cache to avoid wasteful repeat calls. HTTP errors, including 429 rate limits, are surfaced rather than silently retried.

## Security

- Read-only tools only.
- No Battle.net credentials.
- No WoW account login.
- No write operations.
- The server is scoped by environment variables to one configured public character.
