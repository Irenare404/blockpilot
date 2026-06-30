# BlockPilot

BlockPilot is a Minecraft Java bot platform for AI companion play, built around a real in-server bot worker, a gateway layer, an extensible capability system, and a separate agent runtime.

## Current First Slice

The first implementation is the smallest useful control path:

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
- Controlled actions: `chat`, `follow_player`, `report_position`, `world_snapshot`, and `stop`.
- A small built-in chat intent layer for direct follow and stop commands.
- A bot worker plugin runtime for adding capabilities.
- A swappable agent runtime with a rule planner and an OpenAI-compatible LLM planner.

## Direction

- The bot worker joins a Java Minecraft server as a real player client.
- The gateway exposes status, events, world snapshots, tasks, and actions to agents, dashboards, and plugins.
- Built-in skills provide the first useful behaviors before external plugins are needed.
- Plugins extend tools and event handlers through a controlled SDK instead of touching the raw Minecraft client.
- The agent runtime consumes the gateway API, so LLM planning can evolve without changing the worker.

## Requirements

- Node.js 22 or newer.
- pnpm 11 through Corepack.
- A Minecraft Java server. For the first local test, an offline-mode development server is easiest.

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

In another shell, start the worker with your Minecraft server settings:

```powershell
$env:MC_HOST="127.0.0.1"
$env:MC_PORT="25565"
$env:MC_USERNAME="BlockPilot"
$env:MC_AUTH="offline"
corepack pnpm dev:bot
```

In a third shell, start the default rule planner:

```powershell
$env:BLOCKPILOT_BOT_ID="BlockPilot"
$env:BLOCKPILOT_GATEWAY_HTTP="http://127.0.0.1:8787"
$env:BLOCKPILOT_AGENT_PREFIX="!bp"
corepack pnpm dev:agent
```

Then test the agent from Minecraft chat:

```text
!bp help
!bp status
!bp where
!bp world
!bp follow
!bp stop
```

The default rule planner is still useful for quick tests. Use the LLM planner when you want natural language like `BlockPilot 你来我这边一下` instead of mechanical command words.

## Gateway API

Check gateway health:

```bash
curl http://127.0.0.1:8787/health
```

List known bots:

```bash
curl http://127.0.0.1:8787/bots
```

List actions exposed by a bot:

```bash
curl http://127.0.0.1:8787/bots/BlockPilot/actions
```

Each action includes a lightweight parameter schema so agents and future UI surfaces can discover how to call it.

Fetch the bot world snapshot:

```bash
curl http://127.0.0.1:8787/bots/BlockPilot/world
```

The world snapshot includes:

- bot status, current task, recent tasks, nearby players, and recent chat
- nearby entities grouped into hostile mobs, animals, dropped items, and others
- nearby utility blocks, danger blocks, containers, and spawners
- bot inventory, held item, and basic equipment
- a first safety assessment with `safe`, `watch`, `danger`, or `critical`

List current and recent tasks:

```bash
curl http://127.0.0.1:8787/bots/BlockPilot/tasks
```

Send a chat message through the bot:

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

Stop the current bot controls:

```bash
curl -X POST http://127.0.0.1:8787/bots/BlockPilot/actions \
  -H "content-type: application/json" \
  -d "{\"name\":\"stop\"}"
```

Report the bot position through a plugin action:

```bash
curl -X POST http://127.0.0.1:8787/bots/BlockPilot/actions \
  -H "content-type: application/json" \
  -d "{\"name\":\"report_position\",\"args\":{}}"
```

Capture a world snapshot through a plugin action:

```bash
curl -X POST http://127.0.0.1:8787/bots/BlockPilot/actions \
  -H "content-type: application/json" \
  -d "{\"name\":\"world_snapshot\",\"args\":{}}"
```

### Windows cmd Examples

If your bot ID is `BlockPilot`, use these from `cmd.exe`:

```bat
curl http://127.0.0.1:8787/bots
```

```bat
curl http://127.0.0.1:8787/bots/BlockPilot/actions
```

```bat
curl http://127.0.0.1:8787/bots/BlockPilot/world
```

```bat
curl http://127.0.0.1:8787/bots/BlockPilot/tasks
```

```bat
curl -X POST http://127.0.0.1:8787/bots/BlockPilot/actions ^
  -H "content-type: application/json" ^
  -d "{\"name\":\"chat\",\"args\":{\"message\":\"Hello from BlockPilot\"}}"
```

```bat
curl -X POST http://127.0.0.1:8787/bots/BlockPilot/actions ^
  -H "content-type: application/json" ^
  -d "{\"name\":\"follow_player\",\"args\":{\"playerName\":\"YourPlayerName\",\"distance\":2}}"
```

```bat
curl -X POST http://127.0.0.1:8787/bots/BlockPilot/actions ^
  -H "content-type: application/json" ^
  -d "{\"name\":\"stop\"}"
```

```bat
curl -X POST http://127.0.0.1:8787/bots/BlockPilot/actions ^
  -H "content-type: application/json" ^
  -d "{\"name\":\"report_position\",\"args\":{}}"
```

```bat
curl -X POST http://127.0.0.1:8787/bots/BlockPilot/actions ^
  -H "content-type: application/json" ^
  -d "{\"name\":\"world_snapshot\",\"args\":{}}"
```

`follow_player` requires the target player to be visible to the bot.

## Agent Runtime

The agent runtime is a separate process from the bot worker. It polls the gateway world snapshot, watches recent Minecraft chat, and invokes bot actions through the same HTTP control API used by tools and dashboards.

Environment variables:

- `BLOCKPILOT_BOT_ID`: bot id to control. Defaults to `BlockPilot`.
- `BLOCKPILOT_GATEWAY_HTTP`: gateway HTTP base URL. Defaults to `http://127.0.0.1:8787`.
- `BLOCKPILOT_AGENT_PLANNER`: `rule` or `llm`. Defaults to `rule`.
- `BLOCKPILOT_AGENT_PREFIX`: in-game command prefix. Defaults to `!bp`.
- `BLOCKPILOT_AGENT_ALIASES`: comma-separated names players may use for the bot, such as `bp,helper`.
- `BLOCKPILOT_AGENT_ALLOWED_ACTIONS`: comma-separated action whitelist. Defaults to `chat,follow_player,stop,report_position,world_snapshot`.
- `BLOCKPILOT_AGENT_TICK_MS`: polling interval. Defaults to `2000`.

The rule planner handles `!bp help`, `!bp status`, `!bp where`, `!bp world`, `!bp follow`, and `!bp stop`.

The LLM planner sends the model the bot id, the live Minecraft username from the world snapshot, configured aliases, the current speaker, recent chat, nearby players, current task, perception data, safety state, and available capabilities. The model must first return `addressedToBot`; if the message is for another player or general server chat, the agent ignores it. This lets it understand natural phrases such as `BlockPilot 你过来一下`, `小助手跟我走`, or `你先停一下`, while still avoiding random reactions to other players.

The safety model is conservative. A hostile mob near a spawner or vertically separated from the bot is marked as likely contained, so mob farms and spawner machines do not automatically become attack targets.

LLM planner variables:

- `BLOCKPILOT_LLM_API_KEY` or `OPENAI_API_KEY`: API key for an OpenAI-compatible chat completions endpoint.
- `BLOCKPILOT_LLM_BASE_URL`: endpoint base URL. Defaults to `https://api.openai.com/v1`.
- `BLOCKPILOT_LLM_MODEL`: model name. Required for `BLOCKPILOT_AGENT_PLANNER=llm`.
- `BLOCKPILOT_LLM_TEMPERATURE`: defaults to `0.2`.
- `BLOCKPILOT_LLM_TIMEOUT_MS`: defaults to `15000`.

For `cmd.exe`, start it like this:

```bat
set "BLOCKPILOT_BOT_ID=BlockPilot"
set "BLOCKPILOT_GATEWAY_HTTP=http://127.0.0.1:8787"
set "BLOCKPILOT_AGENT_PREFIX=!bp"
corepack pnpm dev:agent
```

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

## First Milestone

1. Start a bot worker with Mineflayer.
2. Connect the worker to a local gateway.
3. Expose basic actions: chat, follow player, and stop task.
4. Add a small intent layer so player chat can trigger actions.
5. Keep the plugin API narrow but ready for growth.
6. Add the first agent runtime that reads context and invokes tools.
