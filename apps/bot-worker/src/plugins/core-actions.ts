import {
  getArgs,
  getOptionalNumberArg,
  getOptionalStringArg,
  requireStringArg,
  type WorkerPlugin,
} from "../plugin-runtime.js";

const FOOD_ITEM_NAMES = [
  "cooked_beef",
  "cooked_porkchop",
  "cooked_mutton",
  "cooked_chicken",
  "cooked_rabbit",
  "baked_potato",
  "bread",
  "pumpkin_pie",
  "carrot",
  "apple",
  "beetroot_soup",
  "mushroom_stew",
  "rabbit_stew",
  "suspicious_stew",
  "cooked_cod",
  "cooked_salmon",
  "melon_slice",
  "sweet_berries",
  "glow_berries",
  "cookie",
  "dried_kelp",
  "golden_apple",
  "enchanted_golden_apple",
];

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

    ctx.actions.register(
      {
        name: "eat_food",
        description: "Eat the best available food item from the bot inventory.",
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
      async (action) => {
        const bot = ctx.minecraft.requireBot();
        const food = bot.inventory
          .items()
          .filter((item) => FOOD_ITEM_NAMES.includes(item.name))
          .sort((a, b) => foodRank(a.name) - foodRank(b.name))[0];

        if (!food) {
          throw new Error("No edible food found in inventory");
        }

        ctx.minecraft.stopCurrentControls(getOptionalStringArg(action, "reason") ?? "Eating food");
        await bot.equip(food, "hand");
        await bot.consume();

        return {
          ok: true,
          message: `Ate ${food.displayName ?? food.name}`,
          data: {
            itemName: food.name,
          },
        };
      },
    );

    ctx.actions.register(
      {
        name: "retreat_from_threat",
        description: "Briefly move away from a threat position without attacking.",
        source: "builtin",
        parameters: {
          type: "object",
          properties: {
            threatX: {
              type: "number",
              description: "Threat x coordinate.",
            },
            threatY: {
              type: "number",
              description: "Threat y coordinate.",
            },
            threatZ: {
              type: "number",
              description: "Threat z coordinate.",
            },
            durationMs: {
              type: "number",
              description: "Retreat duration in milliseconds.",
              default: 1200,
              minimum: 200,
              maximum: 3000,
            },
            jump: {
              type: "boolean",
              description: "Whether to jump while retreating.",
              default: false,
            },
            reason: {
              type: "string",
              description: "Optional reason recorded in the event stream.",
            },
          },
          additionalProperties: false,
        },
      },
      async (action) => {
        const bot = ctx.minecraft.requireBot();
        const args = getArgs(action);
        const durationMs = clamp(getOptionalNumberArg(action, "durationMs") ?? 1_200, 200, 3_000);
        const threatX = getOptionalNumberArg(action, "threatX");
        const threatY = getOptionalNumberArg(action, "threatY");
        const threatZ = getOptionalNumberArg(action, "threatZ");

        ctx.minecraft.stopCurrentControls(getOptionalStringArg(action, "reason") ?? "Retreating from threat");

        if (typeof threatX === "number" && typeof threatY === "number" && typeof threatZ === "number") {
          const position = bot.entity.position;
          const dx = position.x - threatX;
          const dz = position.z - threatZ;
          const distance = Math.sqrt(dx * dx + dz * dz);

          if (distance > 0.01) {
            await bot.lookAt(position.offset((dx / distance) * 8, 0, (dz / distance) * 8), true);
            bot.setControlState("forward", true);
          } else {
            bot.setControlState("back", true);
          }
        } else {
          bot.setControlState("back", true);
        }

        bot.setControlState("sprint", true);
        bot.setControlState("jump", args.jump === true);

        await sleep(durationMs);
        bot.clearControlStates();

        return {
          ok: true,
          message: "Retreated from threat",
          data: {
            durationMs,
          },
        };
      },
    );
  },
};

function foodRank(name: string): number {
  const index = FOOD_ITEM_NAMES.indexOf(name);
  return index === -1 ? FOOD_ITEM_NAMES.length : index;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
