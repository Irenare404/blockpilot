import {
  getOptionalNumberArg,
  getOptionalStringArg,
  requireStringArg,
  type WorkerPlugin,
} from "../plugin-runtime.js";

export const coreActionsPlugin: WorkerPlugin = {
  id: "blockpilot.core-actions",
  name: "Core Actions",
  setup(ctx) {
    ctx.actions.register(
      {
        name: "chat",
        description: "Send a chat message as the bot.",
        source: "builtin",
        parameters: {
          type: "object",
          properties: {
            message: {
              type: "string",
              description: "Message to send in Minecraft chat.",
            },
          },
          required: ["message"],
          additionalProperties: false,
        },
      },
      (action) => {
        ctx.minecraft.requireBot().chat(requireStringArg(action, "message"));
        return {
          ok: true,
          message: "Message sent",
        };
      },
    );

    ctx.actions.register(
      {
        name: "follow_player",
        description: "Follow a visible player with pathfinding.",
        source: "builtin",
        parameters: {
          type: "object",
          properties: {
            playerName: {
              type: "string",
              description: "Visible Minecraft player name to follow.",
            },
            distance: {
              type: "number",
              description: "Preferred follow distance in blocks.",
              default: 2,
              minimum: 1,
              maximum: 16,
            },
          },
          required: ["playerName"],
          additionalProperties: false,
        },
      },
      (action) => {
        const playerName = requireStringArg(action, "playerName");
        const distance = getOptionalNumberArg(action, "distance");
        return ctx.minecraft.followPlayer(playerName, distance);
      },
    );

    ctx.actions.register(
      {
        name: "stop",
        description: "Stop current movement and clear active controls.",
        source: "builtin",
        parameters: {
          type: "object",
          properties: {
            reason: {
              type: "string",
              description: "Optional reason recorded in the event stream.",
            },
          },
          additionalProperties: false,
        },
      },
      (action) => {
        ctx.minecraft.stopCurrentControls(getOptionalStringArg(action, "reason"));
        return {
          ok: true,
          message: "Current controls stopped",
        };
      },
    );
  },
};
