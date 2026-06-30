import {
  getArgs,
  getOptionalBooleanArg,
  getOptionalNumberArg,
  getOptionalStringArg,
  requireStringArg,
  type WorkerPlugin,
} from "../plugin-runtime.js";
import type { SafetyThreatSnapshot, WorldSnapshot } from "@blockpilot/core";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";

type MineflayerBlock = NonNullable<ReturnType<Bot["blockAt"]>>;
type MineflayerEntity = Bot["entity"];
type MineflayerItem = ReturnType<Bot["inventory"]["items"]>[number];

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
const HOSTILE_ENTITY_NAMES = new Set([
  "blaze",
  "bogged",
  "breeze",
  "cave_spider",
  "creeper",
  "drowned",
  "elder_guardian",
  "ender_dragon",
  "enderman",
  "endermite",
  "evoker",
  "ghast",
  "guardian",
  "hoglin",
  "husk",
  "illusioner",
  "magma_cube",
  "phantom",
  "piglin_brute",
  "pillager",
  "ravager",
  "shulker",
  "silverfish",
  "skeleton",
  "slime",
  "spider",
  "stray",
  "vex",
  "vindicator",
  "warden",
  "witch",
  "wither",
  "wither_skeleton",
  "zoglin",
  "zombie",
  "zombie_villager",
  "zombified_piglin",
]);
const HOSTILE_TARGET_ALIASES = new Set([
  "hostile",
  "monster",
  "mob",
  "threat",
  "\u602A",
  "\u602A\u7269",
  "\u654C\u4EBA",
  "\u5A01\u80C1",
]);
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
            settleMs: {
              type: "number",
              description: "Extra delay after each block is gone before selecting the next block.",
              default: 300,
              minimum: 0,
              maximum: 3000,
            },
            waitForDropMs: {
              type: "number",
              description: "Maximum time to wait for a nearby dropped item after digging each block.",
              default: 700,
              minimum: 0,
              maximum: 5000,
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
        const settleMs = Math.floor(clamp(getOptionalNumberArg(action, "settleMs") ?? 300, 0, 3_000));
        const waitForDropMs = Math.floor(clamp(getOptionalNumberArg(action, "waitForDropMs") ?? 700, 0, 5_000));
        const dug: string[] = [];

        ctx.minecraft.stopCurrentControls(`Digging ${[...blockNames].join(",")}`);

        for (let index = 0; index < count; index += 1) {
          const block = findNearestDiggableBlock(bot, blockNames, maxDistance);
          if (!block) {
            break;
          }

          await bot.dig(block);
          await waitForBlockToChange(bot, block, 3_000);
          if (waitForDropMs > 0) {
            await waitForNearbyDroppedItem(bot, block.position, waitForDropMs);
          }
          if (settleMs > 0) {
            await sleep(settleMs);
          }
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
            settleMs,
            waitForDropMs,
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
        name: "drop_item",
        description: "Drop an item stack from the bot inventory or the currently held item.",
        source: "builtin",
        parameters: {
          type: "object",
          properties: {
            itemName: {
              type: "string",
              description: "Optional inventory item name to drop, such as dirt or cobblestone.",
            },
            count: {
              type: "number",
              description: "Number of items to drop from the selected stack.",
              default: 1,
              minimum: 1,
              maximum: 64,
            },
            slot: {
              type: "number",
              description: "Optional inventory slot number to drop from.",
              minimum: 0,
              maximum: 53,
            },
          },
          additionalProperties: false,
        },
      },
      async (action) => {
        const bot = ctx.minecraft.requireBot();
        const itemName = getOptionalStringArg(action, "itemName");
        const slot = getOptionalNumberArg(action, "slot");
        const count = Math.floor(clamp(getOptionalNumberArg(action, "count") ?? 1, 1, 64));
        const item = findInventoryItemForDrop(bot, itemName, slot);
        if (!item) {
          throw new Error(itemName ? `No inventory item '${itemName}' found` : "No inventory item found to drop");
        }

        const dropCount = Math.min(count, item.count);
        ctx.minecraft.stopCurrentControls(`Dropping ${dropCount} ${item.name}`);
        await bot.toss(item.type, null, dropCount);

        const data = {
          itemName: item.name,
          count: dropCount,
          slot: item.slot,
        };

        return {
          ok: true,
          message: `Dropped ${dropCount} ${item.displayName ?? item.name}`,
          data,
        };
      },
    );

    ctx.actions.register(
      {
        name: "attack_nearest_entity",
        description: "Attack the nearest matching non-contained entity once, optionally moving into range first.",
        source: "builtin",
        parameters: {
          type: "object",
          properties: {
            targetName: {
              type: "string",
              description: "Optional entity name, such as zombie, creeper, hostile, monster, or mob.",
            },
            maxDistance: {
              type: "number",
              description: "Maximum target search distance in blocks.",
              default: 8,
              minimum: 1,
              maximum: 32,
            },
            allowPlayers: {
              type: "boolean",
              description: "Allow player entities to be attacked.",
              default: false,
            },
            allowTrapped: {
              type: "boolean",
              description: "Allow attacking entities marked trapped or contained by safety perception.",
              default: false,
            },
            follow: {
              type: "boolean",
              description: "Move toward the target before attacking if it is outside melee range.",
              default: true,
            },
          },
          additionalProperties: false,
        },
      },
      async (action) => {
        const bot = ctx.minecraft.requireBot();
        const world = ctx.world.getSnapshot();
        const targetName = getOptionalStringArg(action, "targetName");
        const maxDistance = clamp(getOptionalNumberArg(action, "maxDistance") ?? 8, 1, 32);
        const allowPlayers = getOptionalBooleanArg(action, "allowPlayers") ?? false;
        const allowTrapped = getOptionalBooleanArg(action, "allowTrapped") ?? false;
        const follow = getOptionalBooleanArg(action, "follow") ?? true;
        const target = findNearestAttackTarget(bot, world, targetName, maxDistance, allowPlayers, allowTrapped);
        if (!target) {
          throw new Error(`No attack target found within ${maxDistance} blocks`);
        }

        const label = getEntityLabel(target);
        const startingDistance = target.position.distanceTo(bot.entity.position);
        ctx.minecraft.stopCurrentControls(`Preparing to attack ${label}`);

        if (follow && startingDistance > 3.2) {
          await ctx.minecraft.goToPosition(target.position.x, target.position.y, target.position.z, 2);
          await waitForEntityDistance(bot, target.id, 3.2, Math.min(6_000, 1_000 + maxDistance * 400));
        }

        const currentTarget = bot.entities[target.id] ?? target;
        if (currentTarget.isValid === false) {
          throw new Error(`Target '${label}' is no longer valid`);
        }

        const attackDistance = currentTarget.position.distanceTo(bot.entity.position);
        if (attackDistance > 4.5) {
          throw new Error(`Target '${label}' is still too far away (${attackDistance.toFixed(1)} blocks)`);
        }

        ctx.minecraft.stopCurrentControls(`Attacking ${label}`);
        await bot.lookAt(currentTarget.position.offset(0, Math.max(0.5, currentTarget.height * 0.8), 0), true);
        bot.attack(currentTarget);
        await sleep(250);

        return {
          ok: true,
          message: `Attacked ${label}`,
          data: {
            entityId: currentTarget.id,
            targetName: getEntityName(currentTarget),
            distance: Math.round(attackDistance * 10) / 10,
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

function findInventoryItemForDrop(bot: Bot, itemName: string | undefined, slot: number | undefined): MineflayerItem | undefined {
  const normalizedItemName = itemName ? normalizeEntityOrItemAlias(itemName) : undefined;

  if (typeof slot === "number" && Number.isFinite(slot)) {
    const item = bot.inventory.slots[Math.floor(slot)];
    if (!item) {
      return undefined;
    }

    return !normalizedItemName || matchesItemName(item, normalizedItemName) ? item : undefined;
  }

  if (normalizedItemName) {
    return bot.inventory.items().find((item) => matchesItemName(item, normalizedItemName));
  }

  return bot.heldItem ?? bot.inventory.items()[0];
}

function findInventoryItem(bot: Bot, itemName: string): ReturnType<Bot["inventory"]["items"]>[number] | undefined {
  return bot.inventory.items().find((item) => matchesItemName(item, itemName));
}

function matchesItemName(item: MineflayerItem, itemName: string): boolean {
  const names = [item.name, item.displayName].filter(isString).map((name) => normalizeEntityOrItemAlias(name));
  return names.includes(itemName);
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

function findNearestAttackTarget(
  bot: Bot,
  world: WorldSnapshot,
  targetName: string | undefined,
  maxDistance: number,
  allowPlayers: boolean,
  allowTrapped: boolean,
): MineflayerEntity | undefined {
  const normalizedTargetName = targetName ? normalizeEntityOrItemAlias(targetName) : undefined;
  return Object.values(bot.entities)
    .filter((entity) => entity.id !== bot.entity.id)
    .filter((entity) => entity.isValid !== false)
    .filter((entity) => entity.position.distanceTo(bot.entity.position) <= maxDistance)
    .filter((entity) => allowPlayers || !isPlayerEntity(entity))
    .filter((entity) => matchesAttackTarget(entity, normalizedTargetName))
    .filter((entity) => allowTrapped || !isContainedThreat(bot, entity, world))
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
}

function matchesAttackTarget(entity: MineflayerEntity, targetName: string | undefined): boolean {
  if (!targetName) {
    return isHostileEntity(entity);
  }

  if (HOSTILE_TARGET_ALIASES.has(targetName)) {
    return isHostileEntity(entity);
  }

  return getEntityNameCandidates(entity).some((candidate) => normalizeEntityOrItemAlias(candidate) === targetName);
}

function isContainedThreat(bot: Bot, entity: MineflayerEntity, world: WorldSnapshot): boolean {
  const threat = findMatchingSafetyThreat(bot, entity, world.safety.threats);
  return threat?.trapped === true || threat?.canReachBot === false || Boolean(threat?.containmentReason);
}

function findMatchingSafetyThreat(
  bot: Bot,
  entity: MineflayerEntity,
  threats: SafetyThreatSnapshot[],
): SafetyThreatSnapshot | undefined {
  const entityName = getEntityName(entity);
  const entityDistance = entity.position.distanceTo(bot.entity.position);

  return threats.find((threat) => {
    if (threat.kind !== "entity" || threat.name !== entityName) {
      return false;
    }

    if (threat.position) {
      return entity.position.distanceTo(new Vec3(threat.position.x, threat.position.y, threat.position.z)) <= 2.5;
    }

    return typeof threat.distance === "number" && Math.abs(threat.distance - entityDistance) <= 2;
  });
}

function isHostileEntity(entity: MineflayerEntity): boolean {
  return entity.type === "hostile" || HOSTILE_ENTITY_NAMES.has(getEntityName(entity));
}

function isPlayerEntity(entity: MineflayerEntity): boolean {
  return entity.type === "player" || Boolean(entity.username);
}

function getEntityLabel(entity: MineflayerEntity): string {
  return entity.username ?? entity.displayName ?? getEntityName(entity);
}

function getEntityName(entity: MineflayerEntity): string {
  return entity.name ?? entity.mobType ?? entity.objectType ?? entity.type ?? "unknown";
}

function getEntityNameCandidates(entity: MineflayerEntity): string[] {
  return [entity.name, entity.mobType, entity.objectType, entity.displayName, entity.username, entity.type].filter(isString);
}

function normalizeEntityOrItemAlias(value: string): string {
  const normalized = normalizeBlockName(value);
  switch (normalized) {
    case "\u50F5\u5C38":
      return "zombie";
    case "\u82E6\u529B\u6015":
      return "creeper";
    case "\u9AB7\u9AC5":
    case "\u5C0F\u767D":
      return "skeleton";
    case "\u8718\u86DB":
      return "spider";
    case "\u6CE5\u571F":
    case "\u571F":
      return "dirt";
    case "\u77F3\u5934":
      return "stone";
    default:
      return normalized;
  }
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

async function waitForBlockToChange(bot: Bot, block: MineflayerBlock, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const current = bot.blockAt(block.position);
    if (!current || current.name !== block.name || AIR_BLOCK_NAMES.has(current.name)) {
      return true;
    }

    await sleep(100);
  }

  const current = bot.blockAt(block.position);
  return !current || current.name !== block.name || AIR_BLOCK_NAMES.has(current.name);
}

async function waitForNearbyDroppedItem(bot: Bot, position: Vec3, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const droppedItem = Object.values(bot.entities).some(
      (entity) => (entity.name === "item" || entity.type === "object") && entity.position.distanceTo(position) <= 2.5,
    );
    if (droppedItem) {
      return true;
    }

    await sleep(100);
  }

  return false;
}

async function waitForEntityDistance(bot: Bot, entityId: number, maxDistance: number, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const entity = bot.entities[entityId];
    if (!entity || entity.isValid === false) {
      return false;
    }

    if (entity.position.distanceTo(bot.entity.position) <= maxDistance) {
      return true;
    }

    await sleep(150);
  }

  const entity = bot.entities[entityId];
  return Boolean(entity && entity.position.distanceTo(bot.entity.position) <= maxDistance);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
