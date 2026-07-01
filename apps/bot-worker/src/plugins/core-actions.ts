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
import type { Vec3 as Vec3Type } from "vec3";
import vec3Package from "vec3";

const { Vec3 } = vec3Package;

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
const LOG_BLOCK_NAMES = [
  "log",
  "log2",
  "oak_log",
  "spruce_log",
  "birch_log",
  "jungle_log",
  "acacia_log",
  "dark_oak_log",
  "mangrove_log",
  "cherry_log",
  "pale_oak_log",
  "crimson_stem",
  "warped_stem",
  "stripped_oak_log",
  "stripped_spruce_log",
  "stripped_birch_log",
  "stripped_jungle_log",
  "stripped_acacia_log",
  "stripped_dark_oak_log",
  "stripped_mangrove_log",
  "stripped_cherry_log",
  "stripped_pale_oak_log",
  "stripped_crimson_stem",
  "stripped_warped_stem",
];
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
            waitForArrival: {
              type: "boolean",
              description: "Wait until the bot is actually within range before returning.",
              default: true,
            },
            timeoutMs: {
              type: "number",
              description: "Maximum time to wait for arrival when waitForArrival is true.",
              default: 12000,
              minimum: 500,
              maximum: 60000,
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
        const waitForArrival = getOptionalBooleanArg(action, "waitForArrival");
        const timeoutMs = getOptionalNumberArg(action, "timeoutMs");
        const options: { timeoutMs?: number; waitForArrival?: boolean } = {};
        if (timeoutMs !== undefined) {
          options.timeoutMs = timeoutMs;
        }
        if (waitForArrival !== undefined) {
          options.waitForArrival = waitForArrival;
        }
        return ctx.minecraft.goToPosition(x, y, z, range, options);
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
            confirmTimeoutMs: {
              type: "number",
              description: "Maximum time to wait for the target block to disappear or change after digging.",
              minimum: 500,
              maximum: 30000,
            },
            x: {
              type: "number",
              description: "Optional exact block x coordinate to dig.",
            },
            y: {
              type: "number",
              description: "Optional exact block y coordinate to dig.",
            },
            z: {
              type: "number",
              description: "Optional exact block z coordinate to dig.",
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
        const confirmTimeoutMs = getOptionalNumberArg(action, "confirmTimeoutMs");
        const exactPosition = getOptionalBlockPositionArg(action);
        const targetCount = exactPosition ? 1 : count;
        const dug: Array<{ name: string; x: number; y: number; z: number }> = [];

        ctx.minecraft.stopCurrentControls(`Digging ${[...blockNames].join(",")}`);

        for (let index = 0; index < targetCount; index += 1) {
          const block = exactPosition
            ? resolveExactBlock(bot, exactPosition, blockNames, maxDistance, (candidate) => bot.canDigBlock(candidate), "diggable")
            : findNearestDiggableBlock(bot, blockNames, maxDistance);
          if (!block) {
            break;
          }

          const timeoutMs = getDigConfirmationTimeoutMs(bot, block, confirmTimeoutMs);
          await bot.dig(block, true);
          const confirmed = await waitForBlockToChange(bot, block, timeoutMs);
          if (!confirmed) {
            const position = toPositionData(block.position);
            throw new Error(
              `Dig did not break '${block.name}' at ${position.x}, ${position.y}, ${position.z} within ${timeoutMs}ms`,
            );
          }
          if (waitForDropMs > 0) {
            await waitForNearbyDroppedItem(bot, block.position, waitForDropMs);
          }
          if (settleMs > 0) {
            await sleep(settleMs);
          }
          dug.push({
            name: block.name,
            ...toPositionData(block.position),
          });
        }

        if (dug.length === 0) {
          throw new Error(`No diggable block found for '${[...blockNames].join(",")}' within ${maxDistance} blocks`);
        }

        return {
          ok: true,
          message: `Dug ${dug.length} confirmed block(s): ${dug.map((item) => item.name).join(", ")}`,
          data: {
            count: dug.length,
            blockName: [...blockNames].join(","),
            confirmed: true,
            blocks: dug,
            settleMs,
            waitForDropMs,
            ...(confirmTimeoutMs === undefined ? {} : { confirmTimeoutMs }),
            ...(exactPosition ? toPositionData(exactPosition) : {}),
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
            confirmTimeoutMs: {
              type: "number",
              description: "Maximum time to wait for the target position to contain the placed block.",
              default: 3000,
              minimum: 500,
              maximum: 15000,
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
        const confirmTimeoutMs = clamp(getOptionalNumberArg(action, "confirmTimeoutMs") ?? 3_000, 500, 15_000);
        const item = findInventoryItem(bot, itemName);
        if (!item) {
          throw new Error(`No inventory item '${itemName}' found`);
        }

        const targetPosition = new Vec3(x, y, z);
        const placement = findPlacementReference(bot, targetPosition);
        if (!placement) {
          throw new Error(`No adjacent reference block found for placement at ${x}, ${y}, ${z}`);
        }

        ctx.minecraft.stopCurrentControls(`Placing ${itemName} at ${x},${y},${z}`);
        await bot.equip(item, "hand");
        await bot.lookAt(new Vec3(x + 0.5, y + 0.5, z + 0.5), true);
        await bot.placeBlock(placement.referenceBlock, placement.faceVector);
        const placedBlock = await waitForPlacedBlock(bot, targetPosition, confirmTimeoutMs);
        if (!placedBlock) {
          throw new Error(`Place did not create a block at ${x}, ${y}, ${z} within ${confirmTimeoutMs}ms`);
        }

        return {
          ok: true,
          message: `Placed ${placedBlock.name} at ${x}, ${y}, ${z}`,
          data: {
            itemName,
            blockName: placedBlock.name,
            confirmed: true,
            x,
            y,
            z,
            confirmTimeoutMs,
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
            x: {
              type: "number",
              description: "Optional exact block x coordinate to use.",
            },
            y: {
              type: "number",
              description: "Optional exact block y coordinate to use.",
            },
            z: {
              type: "number",
              description: "Optional exact block z coordinate to use.",
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
        const exactPosition = getOptionalBlockPositionArg(action);
        const block = exactPosition
          ? resolveExactBlock(bot, exactPosition, blockNames, maxDistance, () => true, "usable")
          : findNearestBlock(bot, blockNames, maxDistance);
        if (!block) {
          throw new Error(`No block found for '${[...blockNames].join(",")}' within ${maxDistance} blocks`);
        }

        ctx.minecraft.stopCurrentControls(`Using ${block.name}`);
        const beforeState = getBlockStateSignature(block);
        await bot.activateBlock(block);
        await sleep(250);
        const afterBlock = bot.blockAt(block.position);
        const afterState = afterBlock ? getBlockStateSignature(afterBlock) : "missing";
        const confirmed = beforeState !== afterState;

        return {
          ok: true,
          message: confirmed ? `Used ${block.name}` : `Activated ${block.name}; state change not confirmed`,
          data: {
            blockName: block.name,
            confirmed,
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
            x: {
              type: "number",
              description: "Optional exact container block x coordinate to inspect.",
            },
            y: {
              type: "number",
              description: "Optional exact container block y coordinate to inspect.",
            },
            z: {
              type: "number",
              description: "Optional exact container block z coordinate to inspect.",
            },
          },
          additionalProperties: false,
        },
      },
      async (action) => {
        const bot = ctx.minecraft.requireBot();
        const maxDistance = clamp(getOptionalNumberArg(action, "maxDistance") ?? 6, 1, 16);
        const exactPosition = getOptionalBlockPositionArg(action);
        const block = exactPosition
          ? resolveExactBlock(bot, exactPosition, CONTAINER_BLOCK_NAMES, maxDistance, () => true, "container")
          : findNearestBlock(bot, CONTAINER_BLOCK_NAMES, maxDistance);
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
              confirmed: true,
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
            entityId: {
              type: "number",
              description: "Optional exact dropped item entity id to collect.",
            },
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
            x: {
              type: "number",
              description: "Optional dropped item x coordinate to prefer.",
            },
            y: {
              type: "number",
              description: "Optional dropped item y coordinate to prefer.",
            },
            z: {
              type: "number",
              description: "Optional dropped item z coordinate to prefer.",
            },
          },
          additionalProperties: false,
        },
      },
      async (action) => {
        const bot = ctx.minecraft.requireBot();
        const itemName = getOptionalStringArg(action, "itemName");
        const entityId = getOptionalNumberArg(action, "entityId");
        const exactPosition = getOptionalPositionArg(action);
        const maxDistance = clamp(getOptionalNumberArg(action, "maxDistance") ?? 16, 1, 32);
        const timeoutMs = clamp(getOptionalNumberArg(action, "timeoutMs") ?? 8_000, 500, 15_000);
        const target = findNearestItemEntity(bot, itemName, maxDistance, entityId, exactPosition);
        if (!target) {
          throw new Error(`No dropped item found within ${maxDistance} blocks`);
        }

        const startPosition = target.position.clone();
        const droppedItem = target.getDroppedItem();
        const droppedItemName = droppedItem?.name;
        const beforeInventoryCount = droppedItemName ? countInventoryItemsByName(bot, droppedItemName) : undefined;
        await ctx.minecraft.goToPosition(startPosition.x, startPosition.y, startPosition.z, 1, {
          timeoutMs,
          waitForArrival: true,
        });
        const pickedUp = await waitForItemPickup(bot, target.id, timeoutMs);
        const inventoryConfirmed =
          beforeInventoryCount === undefined || !droppedItemName
            ? pickedUp
            : countInventoryItemsByName(bot, droppedItemName) > beforeInventoryCount;
        if (!pickedUp || !inventoryConfirmed) {
          throw new Error(`Dropped item '${droppedItemName ?? target.name ?? "item"}' was not confirmed picked up within ${timeoutMs}ms`);
        }

        return {
          ok: true,
          message: "Collected dropped item",
          data: {
            entityId: target.id,
            itemName: droppedItemName ?? target.name ?? "item",
            pickedUp,
            confirmed: true,
            inventoryConfirmed,
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
        const beforeCount = countInventoryItemsByType(bot, item.type);
        ctx.minecraft.stopCurrentControls(`Dropping ${dropCount} ${item.name}`);
        await bot.toss(item.type, null, dropCount);
        const confirmed = await waitForInventoryCountAtMost(bot, item.type, beforeCount - dropCount, 2_000);
        if (!confirmed) {
          throw new Error(`Drop did not reduce inventory count for '${item.name}' within 2000ms`);
        }

        const data = {
          itemName: item.name,
          count: dropCount,
          slot: item.slot,
          confirmed: true,
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
            entityId: {
              type: "number",
              description: "Optional exact entity id to attack.",
            },
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
            confirmTimeoutMs: {
              type: "number",
              description: "Maximum time to wait for target damage or removal after attacking.",
              default: 1200,
              minimum: 200,
              maximum: 5000,
            },
            x: {
              type: "number",
              description: "Optional target x coordinate to prefer.",
            },
            y: {
              type: "number",
              description: "Optional target y coordinate to prefer.",
            },
            z: {
              type: "number",
              description: "Optional target z coordinate to prefer.",
            },
          },
          additionalProperties: false,
        },
      },
      async (action) => {
        const bot = ctx.minecraft.requireBot();
        const world = ctx.world.getSnapshot();
        const entityId = getOptionalNumberArg(action, "entityId");
        const exactPosition = getOptionalPositionArg(action);
        const targetName = getOptionalStringArg(action, "targetName");
        const maxDistance = clamp(getOptionalNumberArg(action, "maxDistance") ?? 8, 1, 32);
        const allowPlayers = getOptionalBooleanArg(action, "allowPlayers") ?? false;
        const allowTrapped = getOptionalBooleanArg(action, "allowTrapped") ?? false;
        const follow = getOptionalBooleanArg(action, "follow") ?? true;
        const confirmTimeoutMs = clamp(getOptionalNumberArg(action, "confirmTimeoutMs") ?? 1_200, 200, 5_000);
        const target = findNearestAttackTarget(bot, world, targetName, maxDistance, allowPlayers, allowTrapped, entityId, exactPosition);
        if (!target) {
          throw new Error(`No attack target found within ${maxDistance} blocks`);
        }

        const label = getEntityLabel(target);
        const startingDistance = target.position.distanceTo(bot.entity.position);
        ctx.minecraft.stopCurrentControls(`Preparing to attack ${label}`);

        if (follow && startingDistance > 3.2) {
          await ctx.minecraft.goToPosition(target.position.x, target.position.y, target.position.z, 2, {
            waitForArrival: false,
          });
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
        const initialHealth = getEntityHealth(currentTarget);
        bot.attack(currentTarget);
        const attackConfirmation = await waitForAttackConfirmation(bot, currentTarget.id, initialHealth, confirmTimeoutMs);

        return {
          ok: true,
          message: attackConfirmation.confirmed ? `Attacked ${label}` : `Attacked ${label}; hit not confirmed`,
          data: {
            entityId: currentTarget.id,
            targetName: getEntityName(currentTarget),
            distance: Math.round(attackDistance * 10) / 10,
            confirmed: attackConfirmation.confirmed,
            damaged: attackConfirmation.damaged,
            targetGone: attackConfirmation.targetGone,
            initialHealth: initialHealth ?? null,
            currentHealth: attackConfirmation.currentHealth ?? null,
            confirmTimeoutMs,
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
            confirmed: true,
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
        const hasThreatPosition = typeof threatX === "number" && typeof threatY === "number" && typeof threatZ === "number";
        const startingThreatDistance = hasThreatPosition ? horizontalDistance(bot.entity.position, threatX, threatZ) : undefined;

        ctx.minecraft.stopCurrentControls(getOptionalStringArg(action, "reason") ?? "Retreating from threat");

        if (hasThreatPosition) {
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
        const endingThreatDistance = hasThreatPosition ? horizontalDistance(bot.entity.position, threatX, threatZ) : undefined;
        const confirmed =
          startingThreatDistance !== undefined && endingThreatDistance !== undefined
            ? endingThreatDistance > startingThreatDistance + 0.25
            : false;

        if (hasThreatPosition && !confirmed) {
          throw new Error(`Retreat did not increase distance from threat within ${durationMs}ms`);
        }

        return {
          ok: true,
          message: confirmed ? "Retreated from threat" : "Retreat controls applied; movement not confirmed",
          data: {
            durationMs,
            confirmed,
            ...(startingThreatDistance === undefined ? {} : { startingThreatDistance }),
            ...(endingThreatDistance === undefined ? {} : { endingThreatDistance }),
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

function getOptionalPositionArg(action: Parameters<typeof getArgs>[0]): Vec3Type | undefined {
  const x = getOptionalNumberArg(action, "x");
  const y = getOptionalNumberArg(action, "y");
  const z = getOptionalNumberArg(action, "z");
  const hasAny = x !== undefined || y !== undefined || z !== undefined;
  if (!hasAny) {
    return undefined;
  }

  if (x === undefined || y === undefined || z === undefined) {
    throw new Error(`Action '${action.name}' requires x, y, and z together for exact targeting`);
  }

  return new Vec3(x, y, z);
}

function getOptionalBlockPositionArg(action: Parameters<typeof getArgs>[0]): Vec3Type | undefined {
  const position = getOptionalPositionArg(action);
  return position ? new Vec3(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z)) : undefined;
}

function toPositionData(position: Vec3Type): { x: number; y: number; z: number } {
  return {
    x: position.x,
    y: position.y,
    z: position.z,
  };
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
    case "tree":
    case "\u6811":
    case "\u6728\u5934":
    case "\u539F\u6728":
    case "wood":
    case "log":
      return LOG_BLOCK_NAMES;
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

function resolveExactBlock(
  bot: Bot,
  position: Vec3Type,
  names: Set<string>,
  maxDistance: number,
  predicate: (block: MineflayerBlock) => boolean,
  expectedKind: string,
): MineflayerBlock {
  const block = bot.blockAt(position);
  if (!block) {
    throw new Error(`No block loaded at ${position.x}, ${position.y}, ${position.z}`);
  }

  if (!matchesBlockName(block.name, names)) {
    throw new Error(
      `Block at ${position.x}, ${position.y}, ${position.z} is '${block.name}', not '${formatExpectedBlockNames(names)}'`,
    );
  }

  const distance = block.position.distanceTo(bot.entity.position);
  if (distance > maxDistance) {
    throw new Error(`Block '${block.name}' at ${position.x}, ${position.y}, ${position.z} is ${distance.toFixed(1)} blocks away`);
  }

  if (!predicate(block)) {
    throw new Error(`Block '${block.name}' at ${position.x}, ${position.y}, ${position.z} is not ${expectedKind}`);
  }

  return block;
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

  if (isLogBlockName(blockName) && hasAnyLogName(names)) {
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

function isLogBlockName(blockName: string): boolean {
  return blockName === "log" || blockName === "log2" || blockName.endsWith("_log") || blockName.endsWith("_stem");
}

function hasAnyLogName(names: Set<string>): boolean {
  return LOG_BLOCK_NAMES.some((name) => names.has(name)) || names.has("wood") || names.has("tree");
}

function formatExpectedBlockNames(names: Set<string>): string {
  if (hasAnyLogName(names)) {
    return "log";
  }

  const values = [...names];
  if (values.length <= 4) {
    return values.join(",");
  }

  return `${values.slice(0, 4).join(",")}...`;
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
  targetPosition: Vec3Type,
): { referenceBlock: MineflayerBlock; faceVector: Vec3Type } | undefined {
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
  entityId: number | undefined,
  exactPosition: Vec3Type | undefined,
): MineflayerEntity | undefined {
  const normalizedTargetName = targetName ? normalizeEntityOrItemAlias(targetName) : undefined;

  if (typeof entityId === "number" && Number.isFinite(entityId)) {
    const entity = bot.entities[Math.floor(entityId)];
    return entity && isValidAttackTarget(bot, world, entity, normalizedTargetName, maxDistance, allowPlayers, allowTrapped, exactPosition)
      ? entity
      : undefined;
  }

  return Object.values(bot.entities)
    .filter((entity) => entity.id !== bot.entity.id)
    .filter((entity) => entity.isValid !== false)
    .filter((entity) => entity.position.distanceTo(bot.entity.position) <= maxDistance)
    .filter((entity) => !exactPosition || entity.position.distanceTo(exactPosition) <= 2.5)
    .filter((entity) => allowPlayers || !isPlayerEntity(entity))
    .filter((entity) => matchesAttackTarget(entity, normalizedTargetName))
    .filter((entity) => allowTrapped || !isContainedThreat(bot, entity, world))
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
}

function isValidAttackTarget(
  bot: Bot,
  world: WorldSnapshot,
  entity: MineflayerEntity,
  targetName: string | undefined,
  maxDistance: number,
  allowPlayers: boolean,
  allowTrapped: boolean,
  exactPosition: Vec3Type | undefined,
): boolean {
  return (
    entity.id !== bot.entity.id &&
    entity.isValid !== false &&
    entity.position.distanceTo(bot.entity.position) <= maxDistance &&
    (!exactPosition || entity.position.distanceTo(exactPosition) <= 2.5) &&
    (allowPlayers || !isPlayerEntity(entity)) &&
    matchesAttackTarget(entity, targetName) &&
    (allowTrapped || !isContainedThreat(bot, entity, world))
  );
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

function findNearestItemEntity(
  bot: Bot,
  itemName: string | undefined,
  maxDistance: number,
  entityId: number | undefined,
  exactPosition: Vec3Type | undefined,
): MineflayerEntity | undefined {
  const normalizedItemName = itemName ? normalizeEntityOrItemAlias(itemName) : undefined;

  if (typeof entityId === "number" && Number.isFinite(entityId)) {
    const entity = bot.entities[Math.floor(entityId)];
    return entity && isValidItemEntity(bot, entity, normalizedItemName, maxDistance, exactPosition) ? entity : undefined;
  }

  const candidates = Object.values(bot.entities)
    .filter((entity) => isValidItemEntity(bot, entity, normalizedItemName, maxDistance, exactPosition))
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
  return candidates[0];
}

function isValidItemEntity(
  bot: Bot,
  entity: MineflayerEntity,
  itemName: string | undefined,
  maxDistance: number,
  exactPosition: Vec3Type | undefined,
): boolean {
  return (
    (entity.name === "item" || entity.type === "object") &&
    entity.position.distanceTo(bot.entity.position) <= maxDistance &&
    (!exactPosition || entity.position.distanceTo(exactPosition) <= 2.5) &&
    (!itemName || getItemEntityNameCandidates(entity).some((candidate) => normalizeEntityOrItemAlias(candidate) === itemName))
  );
}

function getItemEntityNameCandidates(entity: MineflayerEntity): string[] {
  const droppedItem = entity.getDroppedItem();
  return [
    ...getEntityNameCandidates(entity),
    droppedItem?.name,
    droppedItem?.displayName,
  ].filter(isString);
}

function getDigConfirmationTimeoutMs(bot: Bot, block: MineflayerBlock, overrideMs: number | undefined): number {
  if (typeof overrideMs === "number" && Number.isFinite(overrideMs)) {
    return Math.floor(clamp(overrideMs, 500, 30_000));
  }

  const digTimeMs = getBlockDigTimeMs(bot, block);
  const fallbackMs = isLogBlockName(block.name) ? 8_000 : 4_000;
  return Math.floor(clamp((digTimeMs ?? fallbackMs) + 2_500, 3_000, 30_000));
}

function getBlockDigTimeMs(bot: Bot, block: MineflayerBlock): number | undefined {
  const maybeBot = bot as Bot & {
    digTime?: (target: MineflayerBlock) => number;
  };
  if (typeof maybeBot.digTime !== "function") {
    return undefined;
  }

  const value = maybeBot.digTime(block);
  return Number.isFinite(value) ? value : undefined;
}

async function waitForPlacedBlock(bot: Bot, targetPosition: Vec3Type, timeoutMs: number): Promise<MineflayerBlock | undefined> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const current = bot.blockAt(targetPosition);
    if (current && !AIR_BLOCK_NAMES.has(current.name)) {
      return current;
    }

    await sleep(100);
  }

  const current = bot.blockAt(targetPosition);
  return current && !AIR_BLOCK_NAMES.has(current.name) ? current : undefined;
}

function getBlockStateSignature(block: MineflayerBlock): string {
  const maybeBlock = block as MineflayerBlock & {
    _properties?: Record<string, string | number | boolean>;
    properties?: Record<string, string | number | boolean>;
  };

  return JSON.stringify({
    metadata: block.metadata,
    name: block.name,
    properties: maybeBlock._properties ?? maybeBlock.properties ?? {},
    type: block.type,
  });
}

function countInventoryItemsByName(bot: Bot, itemName: string): number {
  const normalizedName = normalizeEntityOrItemAlias(itemName);
  return bot.inventory
    .items()
    .filter((item) => matchesItemName(item, normalizedName))
    .reduce((total, item) => total + item.count, 0);
}

function countInventoryItemsByType(bot: Bot, itemType: number): number {
  return bot.inventory
    .items()
    .filter((item) => item.type === itemType)
    .reduce((total, item) => total + item.count, 0);
}

async function waitForInventoryCountAtMost(bot: Bot, itemType: number, maxCount: number, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (countInventoryItemsByType(bot, itemType) <= maxCount) {
      return true;
    }

    await sleep(100);
  }

  return countInventoryItemsByType(bot, itemType) <= maxCount;
}

interface AttackConfirmation {
  confirmed: boolean;
  currentHealth?: number;
  damaged: boolean;
  targetGone: boolean;
}

async function waitForAttackConfirmation(
  bot: Bot,
  entityId: number,
  initialHealth: number | undefined,
  timeoutMs: number,
): Promise<AttackConfirmation> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const entity = bot.entities[entityId];
    if (!entity || entity.isValid === false) {
      return {
        confirmed: true,
        damaged: false,
        targetGone: true,
      };
    }

    const currentHealth = getEntityHealth(entity);
    if (initialHealth !== undefined && currentHealth !== undefined && currentHealth < initialHealth) {
      return {
        confirmed: true,
        currentHealth,
        damaged: true,
        targetGone: false,
      };
    }

    await sleep(100);
  }

  const entity = bot.entities[entityId];
  const targetGone = !entity || entity.isValid === false;
  const currentHealth = entity ? getEntityHealth(entity) : undefined;
  return {
    confirmed: targetGone,
    damaged: false,
    targetGone,
    ...(currentHealth === undefined ? {} : { currentHealth }),
  };
}

function getEntityHealth(entity: MineflayerEntity): number | undefined {
  const maybeEntity = entity as MineflayerEntity & {
    health?: number;
  };
  return typeof maybeEntity.health === "number" && Number.isFinite(maybeEntity.health) ? maybeEntity.health : undefined;
}

function horizontalDistance(position: Vec3Type, x: number, z: number): number {
  const dx = position.x - x;
  const dz = position.z - z;
  return Math.sqrt(dx * dx + dz * dz);
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

async function waitForNearbyDroppedItem(bot: Bot, position: Vec3Type, timeoutMs: number): Promise<boolean> {
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
