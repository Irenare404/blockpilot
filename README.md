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
- A first rule-based agent runtime that reads world snapshots and calls bot actions.

## Direction

- The bot worker joins a Java Minecraft server as a real player client.
- The gateway exposes status, events, world snapshots, tasks, and actions to agents, dashboards, and plugins.
- Built-in skills provide the first useful behaviors before external plugins are needed.
- Plugins extend tools and event handlers through a controlled SDK instead of touching the raw Minecraft client.
- The agent runtime consumes the gateway API, so future LLM planning can replace the first rule engine without changing the worker.

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

In a third shell, start the first minimal agent runtime:

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

The current agent is intentionally rule-based. It proves the context-reading and tool-calling loop first; the planner can later be replaced by an LLM-backed agent.

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
- `BLOCKPILOT_AGENT_PREFIX`: in-game command prefix. Defaults to `!bp`.
- `BLOCKPILOT_AGENT_TICK_MS`: polling interval. Defaults to `2000`.

The rule agent currently handles `help`, `status`, `where`, `world`, `follow`, and `stop`. It uses the gateway capability list before calling optional actions, so plugin-provided tools can appear in agent context without changing the agent transport.

For `cmd.exe`, start it like this:

```bat
set "BLOCKPILOT_BOT_ID=BlockPilot"
set "BLOCKPILOT_GATEWAY_HTTP=http://127.0.0.1:8787"
set "BLOCKPILOT_AGENT_PREFIX=!bp"
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
