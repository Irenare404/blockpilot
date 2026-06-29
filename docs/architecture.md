# Architecture

BlockPilot starts with an application-level control proxy instead of a Minecraft protocol proxy.

```text
AI Agent / Web Console / Plugins
              |
              v
        Bot Gateway
              |
              v
        Bot Worker
              |
              v
   Java Minecraft Server
```

## Layers

### Bot Worker

The worker owns the live Minecraft connection. It should be small and resilient.

- Connect to a Java server through Mineflayer.
- Normalize Minecraft events into BlockPilot events.
- Execute controlled actions requested by the gateway.
- Maintain a lightweight local connection health state.

### Bot Gateway

The gateway is the control plane for agents, plugins, and future UI surfaces.

- Publish bot status and world snapshots.
- Accept action requests.
- Track task lifecycle and cancellation.
- Apply permissions and audit logging.
- Provide the stable interface used by plugins and agents.

Current gateway endpoints:

- `GET /health`
- `GET /bots`
- `GET /bots/:botId/status`
- `POST /bots/:botId/actions`
- `WS /worker`
- `WS /events`

Current actions:

- `chat`
- `stop`

### Capability Runtime

Capabilities may be built in or loaded as plugins. The agent should see a unified tool registry regardless of where a capability comes from.

- Built-in tools cover core behavior.
- Plugins register optional tools and event handlers.
- The raw Minecraft client is not exposed to plugins by default.
