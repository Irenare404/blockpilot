# BlockPilot

BlockPilot is a Minecraft Java bot platform for AI companion play, built around a real in-server bot worker, a gateway layer, and an extensible capability system.

## Current First Slice

The first implementation is the smallest useful control path:

```text
HTTP / WebSocket client
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
- Two controlled actions: `chat` and `stop`.

## Direction

- The bot worker joins a Java Minecraft server as a real player client.
- The gateway exposes status, events, and actions to agents, dashboards, and plugins.
- Built-in skills provide the first useful behaviors before external plugins are needed.
- Plugins extend tools and event handlers through a controlled SDK instead of touching the raw Minecraft client.

## Requirements

- Node.js 22 or newer.
- pnpm 11 through Corepack.
- A Minecraft Java server. For the first local test, an offline-mode development server is easiest.

## Install

```bash
corepack prepare pnpm@11.9.0 --activate
pnpm install
pnpm build
```

## Run

Start the gateway:

```bash
pnpm dev:gateway
```

In another shell, start the worker with your Minecraft server settings:

```powershell
$env:MC_HOST="127.0.0.1"
$env:MC_PORT="25565"
$env:MC_USERNAME="BlockPilot"
$env:MC_AUTH="offline"
pnpm dev:bot
```

Check gateway health:

```bash
curl http://127.0.0.1:8787/health
```

List known bots:

```bash
curl http://127.0.0.1:8787/bots
```

Send a chat message through the bot:

```bash
curl -X POST http://127.0.0.1:8787/bots/local-bot/actions \
  -H "content-type: application/json" \
  -d "{\"name\":\"chat\",\"args\":{\"message\":\"Hello from BlockPilot\"}}"
```

Stop the current bot controls:

```bash
curl -X POST http://127.0.0.1:8787/bots/local-bot/actions \
  -H "content-type: application/json" \
  -d "{\"name\":\"stop\"}"
```

## First Milestone

1. Start a bot worker with Mineflayer.
2. Connect the worker to a local gateway.
3. Expose basic actions: chat and stop task.
4. Add follow-player as the first movement action.
5. Add a small intent layer so player chat can trigger actions.
6. Keep the plugin API narrow but ready for growth.
