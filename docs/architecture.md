# Architecture

BlockPilot starts with an application-level control proxy instead of a Minecraft protocol proxy.

```text
Agent Runtime / Web Console / Plugins
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
- `GET /bots/:botId/actions`
- `GET /bots/:botId/tasks`
- `GET /bots/:botId/world`
- `POST /bots/:botId/actions`
- `WS /worker`
- `WS /events`

Current actions:

- `chat`
- `follow_player`
- `report_position`
- `stop`
- `world_snapshot`

Current built-in chat intents:

- follow the speaking player
- stop current movement

The worker now keeps built-in actions behind an internal registry and reports its capabilities to the gateway during registration. The gateway exposes those capabilities through `GET /bots/:botId/actions`; later plugin and agent tooling should attach to this registry shape instead of adding one-off action branches.

Capabilities include lightweight parameter schemas. The schema shape intentionally stays close to JSON Schema object parameters so an agent, web console, or plugin host can discover required arguments before invoking an action.

World snapshots are published by the worker and cached by the gateway. They include bot status, capabilities, nearby players, and recent chat. This is the first context surface intended for the agent runtime.

Task snapshots are published for every action invocation. Short actions usually move from `running` to `completed` immediately; long-running actions such as `follow_player` remain `running` until replaced, stopped, failed, or cancelled. The gateway exposes current and recent tasks through `GET /bots/:botId/tasks`.

### Agent Runtime

The agent runtime is a process outside the worker. It consumes the gateway API, reads world snapshots, watches recent chat, and invokes actions through `POST /bots/:botId/actions`.

The first implementation is rule-based and intentionally small:

- Poll `GET /bots/:botId/world`.
- Detect in-game commands with the `!bp` prefix.
- Use the world snapshot capability list before calling optional tools.
- Call `chat`, `report_position`, `follow_player`, and `stop` through the gateway.

This gives BlockPilot the final process boundary needed for an LLM planner: the future planner can replace the current rule interpreter while keeping the same context and tool-calling transport.

### Capability Runtime

Capabilities may be built in or loaded as plugins. The agent should see a unified tool registry regardless of where a capability comes from.

- Built-in tools cover core behavior.
- Plugins register optional tools and event handlers.
- Internal worker plugins receive safe helpers and can opt into the live Mineflayer bot through `ctx.minecraft.requireBot()` for advanced behavior. Future externally loaded plugins should be sandboxed more tightly.

The current worker plugin runtime loads plugins from `apps/bot-worker/src/plugins/index.ts`. This is intentionally static for the first implementation; dynamic discovery and sandboxing can be added once the plugin contract stabilizes.
