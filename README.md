# BlockPilot

BlockPilot is a Minecraft Java bot platform for AI companion play, built around a real in-server bot worker, a gateway layer, and an extensible capability system.

## Direction

- The bot worker joins a Java Minecraft server as a real player client.
- The gateway exposes status, events, and actions to agents, dashboards, and plugins.
- Built-in skills provide the first useful behaviors before external plugins are needed.
- Plugins extend tools and event handlers through a controlled SDK instead of touching the raw Minecraft client.

## First Milestone

1. Start a bot worker with Mineflayer.
2. Connect the worker to a local gateway.
3. Expose basic actions: chat, follow player, stop task.
4. Add a small intent layer so player chat can trigger actions.
5. Keep the plugin API narrow but ready for growth.

