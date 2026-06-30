import {
  getArgs,
  getOptionalNumberArg,
  getOptionalStringArg,
  requireStringArg,
  type WorkerPlugin,
} from "../plugin-runtime.js";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";

type MineflayerBlock = NonNullable<ReturnType<Bot["blockAt"]>>;
type MineflayerEntity = Bot["entity"];

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
const CONTAINER_BLOCK_NAMES = new Set([
  "barrel",
  "chest",
  "dispenser",
  "dropper",
  "hopper",
  "shulker_box",
  "trapped_chest",
]);
const AIR_BLOCK_NAMES = new Set(["air", "cave_air", "void_air"]);
const PLACE_FACES = [
  { offset: new Vec3(0, -1, 0), face: new Vec3(0, 1, 0) },
  { offset: new Vec3(0, 1, 0), face: new Vec3(0, -1, 0) },
  { offset: new Vec3(-1, 0, 0), face: new Vec3(1, 0, 0) },
  { offset: new Vec3(1, 0, 0), face: new Vec3(-1, 0, 0) },
  { offset: new Vec3(0, 0, -1), face: new Vec3(0, 0, 1) },
  { offset: new Vec3(0, 0, 1), face: new Vec3(0, 0, -1) },
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
        name: "place_block",
        description: "Place an inventory block item at an exact world coordinate.",
        source: "builtin",
        parameters: {
          type: "object",
          properties: {
            itemName: {
              type: "string",
              description: "Inventory item name to place, such as dirt or oak_planks.",
            },
            x: {
              type: "number",
              description: "Target x coordinate where the new block should appear.",
            },
            y: {
              type: "number",
              description: "Target y coordinate where the new block should appear.",
            },
            z: {
              type: "number",
              description: "Target z coordinate where the new block should appear.",
            },
          },
          required: ["itemName", "x", "y", "z"],
          additionalProperties: false,
        },
      },
      async (action) => {
        const bot = ctx.minecraft.requireBot();
        const itemName = normalizeBlockName(requireStringArg(action, "itemName"));
        const x = Math.floor(requireNumberArg(action, "x"));
        const y = Math.floor(requireNumberArg(action, "y"));
        const z = Math.floor(requireNumberArg(action, "z"));
        const item = findInventoryItem(bot, itemName);
        if (!item) {
          throw new Error(`No inventory item '${itemName}' found`);
        }

        const placement = findPlacementReference(bot, new Vec3(x, y, z));
        if (!placement) {
          throw new Error(`No adjacent reference block found for placement at ${x}, ${y}, ${z}`);
        }

        ctx.minecraft.stopCurrentControls(`Placing ${itemName} at ${x},${y},${z}`);
        await bot.equip(item, "hand");
        await bot.lookAt(new Vec3(x + 0.5, y + 0.5, z + 0.5), true);
        await bot.placeBlock(placement.referenceBlock, placement.faceVector);

        return {
          ok: true,
          message: `Placed ${itemName} at ${x}, ${y}, ${z}`,
          data: {
            itemName,
            x,
            y,
            z,
          },
        };
      },
    );

    ctx.actions.register(
      {
        name: "use_nearest_block",
        description: "Activate a nearby block, such as a door, button, lever, chest, furnace, or crafting table.",
        source: "builtin",
        parameters: {
          type: "object",
          properties: {
            blockName: {
              type: "string",
              description: "Minecraft block name or comma-separated names. Use door, lever, button, chest, furnace, crafting_table, etc.",
            },
            maxDistance: {
              type: "number",
              description: "Maximum search distance in blocks.",
              default: 5,
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
        const maxDistance = clamp(getOptionalNumberArg(action, "maxDistance") ?? 5, 1, 16);
        const block = findNearestBlock(bot, blockNames, maxDistance);
        if (!block) {
          throw new Error(`No block found for '${[...blockNames].join(",")}' within ${maxDistance} blocks`);
        }

        ctx.minecraft.stopCurrentControls(`Using ${block.name}`);
        await bot.activateBlock(block);

        return {
          ok: true,
          message: `Used ${block.name}`,
          data: {
            blockName: block.name,
            x: block.position.x,
            y: block.position.y,
            z: block.position.z,
          },
        };
      },
    );

    ctx.actions.register(
      {
        name: "inspect_nearest_container",
        description: "Open the nearest container and summarize visible items without moving them.",
        source: "builtin",
        parameters: {
          type: "object",
          properties: {
            maxDistance: {
              type: "number",
              description: "Maximum search distance in blocks.",
              default: 6,
              minimum: 1,
              maximum: 16,
            },
          },
          additionalProperties: false,
        },
      },
      async (action) => {
        const bot = ctx.minecraft.requireBot();
        const maxDistance = clamp(getOptionalNumberArg(action, "maxDistance") ?? 6, 1, 16);
        const block = findNearestBlock(bot, CONTAINER_BLOCK_NAMES, maxDistance);
        if (!block) {
          throw new Error(`No container found within ${maxDistance} blocks`);
        }

        ctx.minecraft.stopCurrentControls(`Inspecting ${block.name}`);
        const container = await bot.openContainer(block);
        try {
          const items = container.containerItems().map((item) => ({
            name: item.name,
            displayName: item.displayName,
            count: item.count,
            slot: item.slot,
          }));

          return {
            ok: true,
            message: items.length === 0 ? `${block.name} is empty` : `${block.name} contains ${items.length} item stack(s)`,
            data: {
              blockName: block.name,
              x: block.position.x,
              y: block.position.y,
              z: block.position.z,
              items,
            },
          };
        } finally {
          container.close();
        }
      },
    );

    ctx.actions.register(
      {
        name: "collect_nearest_item",
        description: "Move to the nearest dropped item and try to pick it up.",
        source: "builtin",
        parameters: {
          type: "object",
          properties: {
            itemName: {
              type: "string",
              description: "Optional dropped item entity name to prefer.",
            },
            maxDistance: {
              type: "number",
              description: "Maximum search distance in blocks.",
              default: 16,
              minimum: 1,
              maximum: 32,
            },
            timeoutMs: {
              type: "number",
              description: "Maximum time to wait for pickup.",
              default: 8000,
              minimum: 500,
              maximum: 15000,
            },
          },
          additionalProperties: false,
        },
      },
      async (action) => {
        const bot = ctx.minecraft.requireBot();
        const itemName = getOptionalStringArg(action, "itemName");
        const maxDistance = clamp(getOptionalNumberArg(action, "maxDistance") ?? 16, 1, 32);
        const timeoutMs = clamp(getOptionalNumberArg(action, "timeoutMs") ?? 8_000, 500, 15_000);
        const target = findNearestItemEntity(bot, itemName, maxDistance);
        if (!target) {
          throw new Error(`No dropped item found within ${maxDistance} blocks`);
        }

        const startPosition = target.position.clone();
        await ctx.minecraft.goToPosition(startPosition.x, startPosition.y, startPosition.z, 1);
        const pickedUp = await waitForItemPickup(bot, target.id, timeoutMs);

        return {
          ok: true,
          message: pickedUp ? "Collected dropped item" : "Moved to dropped item; pickup not confirmed",
          data: {
            entityId: target.id,
            itemName: target.name ?? "item",
            pickedUp,
            x: startPosition.x,
            y: startPosition.y,
            z: startPosition.z,
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
    case "container":
      return ["barrel", "chest", "trapped_chest", "shulker_box"];
    case "door":
      return ["door"];
    case "button":
      return ["button"];
    case "lever":
      return ["lever"];
    default:
      return [name];
  }
}

function findNearestDiggableBlock(bot: Bot, names: Set<string>, maxDistance: number): MineflayerBlock | undefined {
  return findNearestBlock(bot, names, maxDistance, (block) => bot.canDigBlock(block));
}

function findNearestBlock(
  bot: Bot,
  names: Set<string>,
  maxDistance: number,
  predicate: (block: MineflayerBlock) => boolean = () => true,
): MineflayerBlock | undefined {
  const positions = bot.findBlocks({
    point: bot.entity.position,
    matching: (block) => matchesBlockName(block.name, names),
    maxDistance,
    count: 128,
  });

  return positions
    .map((position) => bot.blockAt(position))
    .filter((block): block is MineflayerBlock => Boolean(block))
    .filter(predicate)
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
}

function matchesBlockName(blockName: string, names: Set<string>): boolean {
  if (names.has(blockName)) {
    return true;
  }

  if (names.has("door") && blockName.endsWith("_door")) {
    return true;
  }

  if (names.has("trapdoor") && blockName.endsWith("_trapdoor")) {
    return true;
  }

  if (names.has("button") && blockName.endsWith("_button")) {
    return true;
  }

  if (names.has("pressure_plate") && blockName.endsWith("_pressure_plate")) {
    return true;
  }

  if (names.has("shulker_box") && blockName.endsWith("_shulker_box")) {
    return true;
  }

  return false;
}

function findInventoryItem(bot: Bot, itemName: string): ReturnType<Bot["inventory"]["items"]>[number] | undefined {
  return bot.inventory.items().find((item) => item.name === itemName || item.displayName?.toLowerCase() === itemName);
}

function findPlacementReference(
  bot: Bot,
  targetPosition: Vec3,
): { referenceBlock: MineflayerBlock; faceVector: Vec3 } | undefined {
  const targetBlock = bot.blockAt(targetPosition);
  if (targetBlock && !AIR_BLOCK_NAMES.has(targetBlock.name)) {
    throw new Error(`Target position already contains ${targetBlock.name}`);
  }

  for (const face of PLACE_FACES) {
    const referenceBlock = bot.blockAt(targetPosition.plus(face.offset));
    if (!referenceBlock || AIR_BLOCK_NAMES.has(referenceBlock.name) || referenceBlock.boundingBox === "empty") {
      continue;
    }

    return {
      referenceBlock,
      faceVector: face.face,
    };
  }

  return undefined;
}

function findNearestItemEntity(bot: Bot, itemName: string | undefined, maxDistance: number): MineflayerEntity | undefined {
  const normalizedItemName = itemName ? normalizeBlockName(itemName) : undefined;
  const candidates = Object.values(bot.entities)
    .filter((entity) => entity.name === "item" || entity.type === "object")
    .filter((entity) => entity.position.distanceTo(bot.entity.position) <= maxDistance)
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
  const preferred = normalizedItemName
    ? candidates.filter((entity) => entity.displayName?.toLowerCase() === normalizedItemName || entity.name === normalizedItemName)
    : [];
  return preferred[0] ?? candidates[0];
}

async function waitForItemPickup(bot: Bot, entityId: number, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!bot.entities[entityId]) {
      return true;
    }

    await sleep(250);
  }

  return !bot.entities[entityId];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
