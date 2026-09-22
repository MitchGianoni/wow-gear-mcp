# Fast setup checklist

## 1. Push this project to GitHub

Repository:

```text
git@github.com:MitchGianoni/wow-gear-mcp.git
```

## 2. Deploy the MCP server

Easiest route: GitHub → Render.

- In Render choose **New → Blueprint**.
- Connect `MitchGianoni/wow-gear-mcp`.
- Render will detect `render.yaml` and use the included Dockerfile.
- Wait for the deployment to become healthy.
- Verify:

```text
https://YOUR-HOST/health
```

It should return JSON containing `"status":"ok"`.

The MCP URL will be:

```text
https://YOUR-HOST/mcp
```

## 3. Register it in ChatGPT

- Settings → Security & login → Developer mode ON
- ChatGPT Plugins → +
- Name: `Zandenx WoW Live Gear`
- Connection: public MCP URL
- URL: `https://YOUR-HOST/mcp`
- Authentication: none
- Confirm ChatGPT discovers:
  - `get_character_gear`
  - `get_character_profile`

## 4. Test prompts

Try:

- `@Zandenx WoW Live Gear what am I wearing right now?`
- `@Zandenx WoW Live Gear identify my three weakest equipped slots.`
- `@Zandenx WoW Live Gear check whether my shield has updated.`
- `@Zandenx WoW Live Gear pull my current profile and tell me what content I should target next.`

## What "automatic" means in v1

Once installed, you no longer need to upload screenshots or paste gear lists. ChatGPT can call the tool whenever current gear is relevant.

The remaining limitation is upstream freshness: Raider.IO can lag behind what you just equipped in-game. The plugin returns crawl/update timestamps so stale data can be detected.
