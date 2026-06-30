import {
  getArgs,
  getOptionalNumberArg,
  getOptionalStringArg,
  requireStringArg,
  type WorkerPlugin,
} from "../plugin-runtime.js";
import type { Bot } from "mineflayer";

type MineflayerBlock = NonNullable<ReturnType<Bot["blockAt"]>>;

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
        name: "go_to_position",
        description: "Move toward a world coordinate with pathfinding.",
        source: "builtin",
        parameters: {
          type: "object",
          properties: {
            x: {
              type: "number",
              description: "Target x coordinate.",
            },
            y: {
              type: "number",
              description: "Target y coordinate.",
            },
            z: {
              type: "number",
              description: "Target z coordinate.",
            },
            range: {
              type: "number",
              description: "Acceptable arrival range in blocks.",
              default: 1,
              minimum: 0,
              maximum: 8,
            },
          },
          required: ["x", "y", "z"],
          additionalProperties: false,
        },
      },
      (action) => {
        const x = requireNumberArg(action, "x");
        const y = requireNumberArg(action, "y");
        const z = requireNumberArg(action, "z");
        const range = getOptionalNumberArg(action, "range");
        return ctx.minecraft.goToPosition(x, y, z, range);
      },
    );

    ctx.actions.register(
      {
        name: "dig_nearest_block",
        description: "Dig nearby blocks matching a Minecraft block name, such as dirt or grass_block.",
        source: "builtin",
        parameters: {
          type: "object",
          properties: {
            blockName: {
              type: "string",
              description: "Minecraft block name or comma-separated names, such as dirt,grass_block.",
            },
            maxDistance: {
              type: "number",
              description: "Maximum search distance in blocks.",
              default: 6,
              minimum: 1,
              maximum: 32,
            },
            count: {
              type: "number",
              description: "Maximum number of matching blocks to dig.",
              default: 1,
              minimum: 1,
              maximum: 16,
            },
          },
          required: ["blockName"],
          additionalProperties: false,
        },
      },
      async (action) => {
        const bot = ctx.minecraft.requireBot();
        const blockNames = parseBlockNames(requireStringArg(action, "blockName"));
        const maxDistance = clamp(getOptionalNumberArg(action, "maxDistance") ?? 6, 1, 32);
        const count = Math.floor(clamp(getOptionalNumberArg(action, "count") ?? 1, 1, 16));
        const dug: string[] = [];

        ctx.minecraft.stopCurrentControls(`Digging ${[...blockNames].join(",")}`);

        for (let index = 0; index < count; index += 1) {
          const block = findNearestDiggableBlock(bot, blockNames, maxDistance);
          if (!block) {
            break;
          }

          await bot.dig(block);
          dug.push(block.name);
        }

        if (dug.length === 0) {
          throw new Error(`No diggable block found for '${[...blockNames].join(",")}' within ${maxDistance} blocks`);
        }

        return {
          ok: true,
          message: `Dug ${dug.length} block(s): ${dug.join(", ")}`,
          data: {
            count: dug.length,
            blockName: [...blockNames].join(","),
          },
        };
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

function requireNumberArg(action: Parameters<typeof getArgs>[0], key: string): number {
  const value = getArgs(action)[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Action '${action.name}' requires number argument '${key}'`);
  }

  return value;
}

function parseBlockNames(value: string): Set<string> {
  const names = value
    .split(",")
    .map((item) => normalizeBlockName(item))
    .filter(Boolean);

  if (names.length === 0) {
    throw new Error("dig_nearest_block requires at least one block name");
  }

  return new Set(names.flatMap((name) => expandBlockName(name)));
}

function normalizeBlockName(value: string): string {
  return value.trim().toLowerCase().replace(/^minecraft:/u, "").replace(/\s+/gu, "_");
}

function expandBlockName(name: string): string[] {
  switch (name) {
    case "dirt":
      return ["dirt", "grass_block", "coarse_dirt", "rooted_dirt", "podzol"];
    case "stone":
      return ["stone", "cobblestone", "deepslate"];
    case "wood":
    case "log":
      return ["oak_log", "spruce_log", "birch_log", "jungle_log", "acacia_log", "dark_oak_log", "mangrove_log", "cherry_log"];
    default:
      return [name];
  }
}

function findNearestDiggableBlock(bot: Bot, names: Set<string>, maxDistance: number): MineflayerBlock | undefined {
  const positions = bot.findBlocks({
    point: bot.entity.position,
    matching: (block) => names.has(block.name),
    maxDistance,
    count: 64,
  });

  const blocks = positions
    .map((position) => bot.blockAt(position))
    .filter((block): block is MineflayerBlock => Boolean(block))
    .filter((block) => bot.canDigBlock(block))
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));

  return blocks[0];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
