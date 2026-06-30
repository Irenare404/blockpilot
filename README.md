# BlockPilot

BlockPilot is a Minecraft Java bot platform for AI companion play, built around a real in-server bot worker, a gateway layer, an extensible capability system, and a separate agent runtime.

## Current First Slice

```text
Agent Runtime / HTTP Client / Web Console
                 |
                 v
          BlockPilot Gateway
                 |
                 v
             Bot Worker
                 |
                 v
        Minecraft Java Server
```

It supports:

- Gateway health and bot status APIs.
- A bot worker that joins a Java server through Mineflayer.
- Worker registration through WebSocket.
- Event streaming for bot status and Minecraft chat events.
- Controlled actions: `chat`, `follow_player`, `eat_food`, `retreat_from_threat`, `report_position`, `world_snapshot`, and `stop`.
- Local world perception for entities, important blocks, inventory, equipment, and safety.
- Safety reflexes for eating and retreating before the LLM planner runs.
- A bot worker plugin runtime for adding capabilities.
- A swappable agent runtime with a rule planner and an OpenAI-compatible LLM planner.

## Requirements

- Node.js 22 or newer.
- pnpm 11 through Corepack.
- A Minecraft Java server. For local testing, an offline-mode development server is easiest.

## Install

```bash
corepack prepare pnpm@11.9.0 --activate
corepack pnpm install
corepack pnpm build
```

## Run

Start the gateway:

```bash
corepack pnpm dev:gateway
```

In another shell, start the worker:

```powershell
$env:MC_HOST="127.0.0.1"
$env:MC_PORT="25565"
$env:MC_USERNAME="BlockPilot"
$env:MC_AUTH="offline"
corepack pnpm dev:bot
```

In a third shell, start the agent runtime:

```powershell
$env:BLOCKPILOT_BOT_ID="BlockPilot"
$env:BLOCKPILOT_GATEWAY_HTTP="http://127.0.0.1:8787"
$env:BLOCKPILOT_AGENT_PREFIX="!bp"
corepack pnpm dev:agent
```

Rule planner test commands in Minecraft chat:

```text
!bp help
!bp status
!bp where
!bp world
!bp follow
!bp stop
```

Use the LLM planner when you want natural language like `BlockPilot come here please` or Chinese phrases such as &#x4F60;&#x8FC7;&#x6765;&#x4E00;&#x4E0B; instead of mechanical command words.

## Gateway API

```bash
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/bots
curl http://127.0.0.1:8787/bots/BlockPilot/actions
curl http://127.0.0.1:8787/bots/BlockPilot/world
curl http://127.0.0.1:8787/bots/BlockPilot/tasks
```

The world snapshot includes:

- bot status, current task, recent tasks, nearby players, and recent chat
- nearby entities grouped into hostile mobs, animals, dropped items, and others
- nearby utility blocks, danger blocks, containers, and spawners
- bot inventory, held item, and basic equipment
- a safety assessment with `safe`, `watch`, `danger`, or `critical`

Send chat:

```bash
curl -X POST http://127.0.0.1:8787/bots/BlockPilot/actions \
  -H "content-type: application/json" \
  -d "{\"name\":\"chat\",\"args\":{\"message\":\"Hello from BlockPilot\"}}"
```

Follow a visible player:

```bash
curl -X POST http://127.0.0.1:8787/bots/BlockPilot/actions \
  -H "content-type: application/json" \
  -d "{\"name\":\"follow_player\",\"args\":{\"playerName\":\"Steve\",\"distance\":2}}"
```

Stop controls:

```bash
curl -X POST http://127.0.0.1:8787/bots/BlockPilot/actions \
  -H "content-type: application/json" \
  -d "{\"name\":\"stop\"}"
```

Eat food from inventory:

```bash
curl -X POST http://127.0.0.1:8787/bots/BlockPilot/actions \
  -H "content-type: application/json" \
  -d "{\"name\":\"eat_food\",\"args\":{\"reason\":\"manual safety test\"}}"
```

Retreat from a threat position:

```bash
curl -X POST http://127.0.0.1:8787/bots/BlockPilot/actions \
  -H "content-type: application/json" \
  -d "{\"name\":\"retreat_from_threat\",\"args\":{\"threatX\":0,\"threatY\":64,\"threatZ\":0,\"durationMs\":1200}}"
```

Plugin actions:

```bash
curl -X POST http://127.0.0.1:8787/bots/BlockPilot/actions \
  -H "content-type: application/json" \
  -d "{\"name\":\"report_position\",\"args\":{}}"
```

```bash
curl -X POST http://127.0.0.1:8787/bots/BlockPilot/actions \
  -H "content-type: application/json" \
  -d "{\"name\":\"world_snapshot\",\"args\":{}}"
```

### Windows cmd Examples

```bat
curl http://127.0.0.1:8787/bots
curl http://127.0.0.1:8787/bots/BlockPilot/actions
curl http://127.0.0.1:8787/bots/BlockPilot/world
curl http://127.0.0.1:8787/bots/BlockPilot/tasks
```

```bat
curl -X POST http://127.0.0.1:8787/bots/BlockPilot/actions ^
  -H "content-type: application/json" ^
  -d "{\"name\":\"follow_player\",\"args\":{\"playerName\":\"YourPlayerName\",\"distance\":2}}"
```

```bat
curl -X POST http://127.0.0.1:8787/bots/BlockPilot/actions ^
  -H "content-type: application/json" ^
  -d "{\"name\":\"retreat_from_threat\",\"args\":{\"threatX\":0,\"threatY\":64,\"threatZ\":0,\"durationMs\":1200}}"
```

`follow_player` requires the target player to be visible to the bot.

## Agent Runtime

The agent runtime is a separate process from the bot worker. It polls the gateway world snapshot, watches recent Minecraft chat, runs safety reflexes, and invokes bot actions through the same HTTP control API used by tools and dashboards.

Environment variables:

- `BLOCKPILOT_BOT_ID`: bot id to control. Defaults to `BlockPilot`.
- `BLOCKPILOT_GATEWAY_HTTP`: gateway HTTP base URL. Defaults to `http://127.0.0.1:8787`.
- `BLOCKPILOT_AGENT_PLANNER`: `rule` or `llm`. Defaults to `rule`.
- `BLOCKPILOT_AGENT_PREFIX`: in-game command prefix. Defaults to `!bp`.
- `BLOCKPILOT_AGENT_ALIASES`: comma-separated names players may use for the bot, such as `bp,helper`.
- `BLOCKPILOT_AGENT_ALLOWED_ACTIONS`: comma-separated action whitelist. Defaults to `chat,follow_player,stop,report_position,world_snapshot,eat_food,retreat_from_threat`.
- `BLOCKPILOT_AGENT_TICK_MS`: polling interval. Defaults to `2000`.
- `BLOCKPILOT_RESPONSE_DEDUP_MS`: suppress identical bot chat replies within this window. Defaults to `30000`.
- `BLOCKPILOT_SAFETY_REFLEX`: enable local safety reflexes. Defaults to `true`.
- `BLOCKPILOT_SAFETY_COOLDOWN_MS`: minimum delay between safety actions. Defaults to `5000`.
- `BLOCKPILOT_SAFETY_NOTICE`: send chat notices for safety reflexes. Defaults to `false`.
- `BLOCKPILOT_SAFETY_NOTICE_COOLDOWN_MS`: minimum delay between safety chat notices. Defaults to `15000`.

Safety reflexes run before the rule or LLM planner. When the bot is hungry or hurt it can call `eat_food`; when a reachable immediate threat is detected it can call `retreat_from_threat`. The reflex skips threats marked as trapped, such as likely mob-farm entities. Safety reflex chat notices are off by default so the bot does not spam mechanical status lines while acting.

The agent handles only the newest unprocessed player chat message each tick. Older queued chat is marked handled to avoid delayed duplicate-looking replies after safety reflexes or slow LLM calls.

The LLM planner receives the bot id, live Minecraft username, configured aliases, current speaker, recent chat, nearby players, current task, perception data, safety state, and available capabilities. The model must first return `addressedToBot`; if the message is for another player or general server chat, the agent ignores it.

LLM planner variables:

- `BLOCKPILOT_LLM_API_KEY` or `OPENAI_API_KEY`: API key for an OpenAI-compatible chat completions endpoint.
- `BLOCKPILOT_LLM_BASE_URL`: endpoint base URL. Defaults to `https://api.openai.com/v1`.
- `BLOCKPILOT_LLM_MODEL`: model name. Required for `BLOCKPILOT_AGENT_PLANNER=llm`.
- `BLOCKPILOT_LLM_TEMPERATURE`: defaults to `0.2`.
- `BLOCKPILOT_LLM_TIMEOUT_MS`: defaults to `15000`.

For `cmd.exe`, start the LLM planner like this:

```bat
set "BLOCKPILOT_BOT_ID=BlockPilot"
set "BLOCKPILOT_GATEWAY_HTTP=http://127.0.0.1:8787"
set "BLOCKPILOT_AGENT_PLANNER=llm"
set "BLOCKPILOT_AGENT_ALIASES=bp,helper"
set "BLOCKPILOT_LLM_API_KEY=your-api-key"
set "BLOCKPILOT_LLM_MODEL=your-model-name"
corepack pnpm dev:agent
```

## Plugins

Bot worker capabilities are registered through plugins. See [docs/plugins.md](docs/plugins.md) for the current plugin shape and an example action.

### In-Game Chat Intents

The worker still has a tiny direct intent layer for quick movement tests. Follow commands:

```text
come
come here
follow
follow me
```

Stop commands:

```text
stop
cancel
```

Chinese aliases are also recognized for common follow and stop phrases, including &#x8FC7;&#x6765; and &#x505C;&#x6B62;.

Longer messages should address the bot by name, for example `BlockPilot come here`. Agent commands use the explicit `!bp` prefix and are handled by `agent-runtime`.
