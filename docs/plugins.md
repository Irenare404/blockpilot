# Plugins

Bot worker plugins register capabilities without editing the gateway or the worker control flow.

## Add a Plugin

Create a file under `apps/bot-worker/src/plugins/`:

```ts
import { requireStringArg, type WorkerPlugin } from "../plugin-runtime.js";

export const examplePlugin: WorkerPlugin = {
  id: "example.echo",
  name: "Example Echo",
  setup(ctx) {
    ctx.actions.register(
      {
        name: "echo",
        description: "Repeat a message in Minecraft chat.",
        source: "plugin",
        parameters: {
          type: "object",
          properties: {
            message: {
              type: "string",
              description: "Message to repeat.",
            },
          },
          required: ["message"],
          additionalProperties: false,
        },
      },
      (action) => {
        const message = requireStringArg(action, "message");
        ctx.minecraft.chat(message);
        return {
          ok: true,
          message: "Echo sent",
        };
      },
    );
  },
};
```

Then add it to `apps/bot-worker/src/plugins/index.ts`:

```ts
export const builtInPlugins: WorkerPlugin[] = [
  coreActionsPlugin,
  chatIntentsPlugin,
  reportPositionPlugin,
  examplePlugin,
];
```

## Plugin Context

Plugins receive a controlled context:

- `ctx.actions.register(...)` registers an action and its parameter schema.
- `ctx.actions.execute(...)` invokes another registered action.
- `ctx.events.onChat(...)` listens to Minecraft chat messages.
- `ctx.minecraft.chat(...)` sends chat as the bot.
- `ctx.minecraft.requireBot()` returns the live Mineflayer bot for advanced behavior.
- `ctx.minecraft.followPlayer(...)` and `ctx.minecraft.stopCurrentControls(...)` expose safe movement helpers.
- `ctx.emitEvent(...)` publishes events to the gateway.
- `ctx.world.getSnapshot()` reads the current world snapshot.

## Current Plugins

- `blockpilot.core-actions`: `chat`, `eat_food`, `follow_player`, `retreat_from_threat`, `stop`
- `blockpilot.chat-intents`: in-game follow and stop commands
- `blockpilot.report-position`: `report_position`
- `blockpilot.world-snapshot`: `world_snapshot`
