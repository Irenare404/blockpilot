import type { WorkerPlugin } from "../plugin-runtime.js";

export const reportPositionPlugin: WorkerPlugin = {
  id: "blockpilot.report-position",
  name: "Report Position",
  setup(ctx) {
    ctx.actions.register(
      {
        name: "report_position",
        description: "Report the bot's current position in chat and return it as action data.",
        source: "plugin",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
      () => {
        const bot = ctx.minecraft.requireBot();
        const position = bot.entity.position;
        const rounded = {
          x: round(position.x),
          y: round(position.y),
          z: round(position.z),
        };
        const dimension = bot.game.dimension;
        const message = `Position: ${rounded.x}, ${rounded.y}, ${rounded.z} (${dimension})`;

        ctx.minecraft.chat(message);

        return {
          ok: true,
          message,
          data: {
            dimension,
            position: rounded,
          },
        };
      },
    );
  },
};

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
