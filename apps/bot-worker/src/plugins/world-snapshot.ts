import { toJsonValue, type WorkerPlugin } from "../plugin-runtime.js";

export const worldSnapshotPlugin: WorkerPlugin = {
  id: "blockpilot.world-snapshot",
  name: "World Snapshot",
  setup(ctx) {
    ctx.actions.register(
      {
        name: "world_snapshot",
        description: "Return the bot's current world context for agents and tools.",
        source: "plugin",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
      () => {
        const snapshot = ctx.world.getSnapshot();
        return {
          ok: true,
          message: "World snapshot captured",
          data: {
            snapshot: toJsonValue(snapshot),
          },
        };
      },
    );
  },
};
