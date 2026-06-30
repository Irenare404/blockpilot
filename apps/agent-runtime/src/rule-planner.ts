import type { BotCapability, ChatMessageSnapshot, JsonRecord, WorldSnapshot } from "@blockpilot/core";
import { ignorePlan, type AgentPlan, type AgentPlanner, type PlannerContext } from "./planner.js";

type AgentCommand =
  | {
      name: "follow";
      chat: ChatMessageSnapshot;
    }
  | {
      name: "dig";
      chat: ChatMessageSnapshot;
      blockName: string;
    }
  | {
      name: "drop_item";
      chat: ChatMessageSnapshot;
      count?: number;
      itemName?: string;
    }
  | {
      name: "attack";
      chat: ChatMessageSnapshot;
      targetName?: string;
    }
  | {
      name: "use_block";
      chat: ChatMessageSnapshot;
      blockName: string;
    }
  | {
      name: "place_block";
      chat: ChatMessageSnapshot;
      itemName: string;
      x: number;
      y: number;
      z: number;
    }
  | {
      name:
        | "collect_item"
        | "go_home"
        | "help"
        | "home"
        | "inspect_container"
        | "memory"
        | "set_home"
        | "status"
        | "stop"
        | "task_collect"
        | "task_patrol"
        | "task_storage"
        | "where"
        | "world";
      chat: ChatMessageSnapshot;
    };

const HELP_ALIASES = new Set(["", "help", "?", "\u5E2E\u52A9"]);
const STATUS_ALIASES = new Set(["status", "\u72B6\u6001", "\u4EFB\u52A1"]);
const WHERE_ALIASES = new Set([
  "where",
  "position",
  "pos",
  "\u5750\u6807",
  "\u5728\u54EA",
  "\u4F60\u5728\u54EA",
]);
const WORLD_ALIASES = new Set(["world", "\u9644\u8FD1", "\u73A9\u5BB6"]);
const CONTAINER_ALIASES = new Set([
  "container",
  "containers",
  "chest",
  "inspect container",
  "inspect chest",
  "\u7BB1\u5B50",
  "\u770B\u7BB1\u5B50",
  "\u4ED3\u5E93",
  "\u770B\u4ED3\u5E93",
]);
const COLLECT_ALIASES = new Set([
  "collect",
  "collect item",
  "pickup",
  "pickup item",
  "\u6361\u4E1C\u897F",
  "\u6361\u6389\u843D\u7269",
]);
const TASK_COLLECT_ALIASES = new Set(["task collect", "collect task", "queue collect", "\u4EFB\u52A1 \u6536\u96C6"]);
const TASK_STORAGE_ALIASES = new Set(["task storage", "task container", "storage task", "\u4EFB\u52A1 \u4ED3\u5E93"]);
const TASK_PATROL_ALIASES = new Set(["patrol", "task patrol", "queue patrol", "\u5DE1\u903B", "\u4EFB\u52A1 \u5DE1\u903B"]);
const HOME_ALIASES = new Set(["home", "base", "\u5BB6", "\u57FA\u5730"]);
const MEMORY_ALIASES = new Set(["memory", "mem", "\u8BB0\u5FC6"]);
const SET_HOME_ALIASES = new Set([
  "sethome",
  "set home",
  "remember home",
  "\u8BBE\u5BB6",
  "\u8BBE\u7F6E\u5BB6",
  "\u8BB0\u4F4F\u8FD9\u91CC\u662F\u5BB6",
]);
const GO_HOME_ALIASES = new Set(["go home", "return home", "back home", "\u56DE\u5BB6", "\u56DE\u57FA\u5730"]);
const FOLLOW_ALIASES = new Set([
  "follow",
  "follow me",
  "\u8DDF\u968F",
  "\u8DDF\u7740\u6211",
  "\u8FC7\u6765",
]);
const STOP_ALIASES = new Set(["stop", "cancel", "\u505C\u6B62", "\u505C\u4E0B"]);

export class RulePlanner implements AgentPlanner {
  async plan(context: PlannerContext): Promise<AgentPlan> {
    const command = parseCommand(context.chat, context.commandPrefix);
    if (!command) {
      return ignorePlan("message did not use the command prefix");
    }

    return executeCommand(command, context);
  }
}

function parseCommand(chat: ChatMessageSnapshot, commandPrefix: string): AgentCommand | undefined {
  const message = normalizeSpacing(chat.message);
  const prefix = normalizeSpacing(commandPrefix);

  if (!message.startsWith(prefix)) {
    return undefined;
  }

  const rest = message.slice(prefix.length);
  if (!isCommandBoundary(rest)) {
    return undefined;
  }

  const command = normalizeCommand(rest);

  if (HELP_ALIASES.has(command)) {
    return { name: "help", chat };
  }

  if (STATUS_ALIASES.has(command)) {
    return { name: "status", chat };
  }

  if (WHERE_ALIASES.has(command)) {
    return { name: "where", chat };
  }

  if (WORLD_ALIASES.has(command)) {
    return { name: "world", chat };
  }

  if (HOME_ALIASES.has(command)) {
    return { name: "home", chat };
  }

  if (MEMORY_ALIASES.has(command)) {
    return { name: "memory", chat };
  }

  if (SET_HOME_ALIASES.has(command)) {
    return { name: "set_home", chat };
  }

  if (GO_HOME_ALIASES.has(command)) {
    return { name: "go_home", chat };
  }

  if (CONTAINER_ALIASES.has(command)) {
    return { name: "inspect_container", chat };
  }

  if (COLLECT_ALIASES.has(command)) {
    return { name: "collect_item", chat };
  }

  if (TASK_COLLECT_ALIASES.has(command)) {
    return { name: "task_collect", chat };
  }

  if (TASK_STORAGE_ALIASES.has(command)) {
    return { name: "task_storage", chat };
  }

  if (TASK_PATROL_ALIASES.has(command)) {
    return { name: "task_patrol", chat };
  }

  const placeCommand = parsePlaceCommand(command);
  if (placeCommand) {
    return { name: "place_block", chat, ...placeCommand };
  }

  const useBlockName = parseUseBlockName(command);
  if (useBlockName) {
    return { name: "use_block", chat, blockName: useBlockName };
  }

  const dropCommand = parseDropCommand(command);
  if (dropCommand) {
    return { name: "drop_item", chat, ...dropCommand };
  }

  const attackCommand = parseAttackCommand(command);
  if (attackCommand) {
    return { name: "attack", chat, ...attackCommand };
  }

  const digBlockName = parseDigBlockName(command);
  if (digBlockName) {
    return { name: "dig", chat, blockName: digBlockName };
  }

  if (FOLLOW_ALIASES.has(command)) {
    return { name: "follow", chat };
  }

  if (STOP_ALIASES.has(command)) {
    return { name: "stop", chat };
  }

  return { name: "help", chat };
}

function executeCommand(command: AgentCommand, context: PlannerContext): AgentPlan {
  const world = context.world;
  switch (command.name) {
    case "help":
      return addressedPlan([{ type: "say", message: createHelpMessage(world.capabilities, context.commandPrefix) }]);
    case "status":
      return addressedPlan([{ type: "say", message: createStatusMessage(world) }]);
    case "where":
      if (hasCapability(world.capabilities, "report_position")) {
        return addressedPlan([{ type: "action", action: { name: "report_position", args: {} } }]);
      }
      return addressedPlan([{ type: "say", message: createPositionMessage(world) }]);
    case "world":
      return addressedPlan([{ type: "say", message: createWorldMessage(world) }]);
    case "home":
      return addressedPlan([{ type: "say", message: createHomeMessage(context) }]);
    case "memory":
      return addressedPlan([{ type: "say", message: createMemoryMessage(context) }]);
    case "set_home":
      return addressedPlan([
        {
          type: "memory",
          operation: "set_home",
          notes: `Set by '${command.chat.username}' through rule command.`,
        },
        { type: "say", message: "Home saved at my current position." },
      ]);
    case "go_home":
      return createGoHomePlan(context);
    case "dig":
      return createDigPlan(command, context);
    case "drop_item":
      return createDropItemPlan(command, context);
    case "attack":
      return createAttackPlan(command, context);
    case "use_block":
      return createUseBlockPlan(command, context);
    case "inspect_container":
      return createInspectContainerPlan(context);
    case "collect_item":
      return createCollectItemPlan(context);
    case "place_block":
      return createPlaceBlockPlan(command, context);
    case "task_collect":
      return createCollectTaskPlan(context);
    case "task_storage":
      return createStorageTaskPlan(context);
    case "task_patrol":
      return createPatrolTaskPlan(context);
    case "follow":
      return addressedPlan([
        {
          type: "action",
          action: {
            name: "follow_player",
            args: {
              playerName: command.chat.username,
              distance: 2,
            },
          },
        },
      ]);
    case "stop":
      return addressedPlan([
        {
          type: "action",
          action: {
            name: "stop",
            args: {
              reason: `Agent stop command from '${command.chat.username}'`,
            },
          },
        },
      ]);
  }
}

function addressedPlan(steps: AgentPlan["steps"]): AgentPlan {
  return {
    addressedToBot: true,
    confidence: 1,
    steps,
  };
}

function createHelpMessage(capabilities: BotCapability[], prefix: string): string {
  const names = capabilities.map((capability) => capability.name).sort().join(", ");
  return `Agent commands: ${prefix} help/status/where/world/follow/stop/home/sethome/go home/memory/dig dirt/drop dirt/attack zombie/container/use door/collect item/place dirt x y z/task collect/task storage/patrol. Tools: ${names || "none"}.`;
}

function createPositionMessage(world: WorldSnapshot): string {
  const position = world.status.position;
  if (!position) {
    return "I do not know my position yet.";
  }

  return `Position: ${position.x}, ${position.y}, ${position.z} (${world.status.dimension ?? "unknown"})`;
}

function createStatusMessage(world: WorldSnapshot): string {
  const health = world.status.health ?? "?";
  const food = world.status.food ?? "?";
  const position = world.status.position
    ? `${world.status.position.x}, ${world.status.position.y}, ${world.status.position.z}`
    : "unknown";
  const task = world.currentTask ? `${world.currentTask.actionName}:${world.currentTask.state}` : "idle";

  return `Status: hp=${health}, food=${food}, pos=${position}, task=${task}.`;
}

function createWorldMessage(world: WorldSnapshot): string {
  if (world.nearbyPlayers.length === 0) {
    return "No nearby visible players.";
  }

  const players = world.nearbyPlayers
    .slice(0, 5)
    .map((player) => `${player.username}${typeof player.distance === "number" ? `(${player.distance})` : ""}`)
    .join(", ");

  return `Nearby: ${players}.`;
}

function createHomeMessage(context: PlannerContext): string {
  const home = context.memory?.home;
  if (!home) {
    return "I do not know home yet. Use !bp sethome when I am standing at home.";
  }

  return `Home: ${formatPosition(home.position)} (${home.dimension ?? "unknown"}).`;
}

function createMemoryMessage(context: PlannerContext): string {
  const memory = context.memory;
  if (!memory) {
    return "Memory is not loaded yet.";
  }

  const home = memory.home ? `home=${formatPosition(memory.home.position)}` : "home=unknown";
  const players = memory.players
    .slice(0, 3)
    .map((player) => player.username)
    .join(", ");
  const places = memory.places
    .slice(0, 3)
    .map((place) => `${place.kind}:${place.name}`)
    .join(", ");

  return `Memory: ${home}; players=${players || "none"}; places=${places || "none"}.`;
}

function createGoHomePlan(context: PlannerContext): AgentPlan {
  const home = context.memory?.home;
  if (!home) {
    return addressedPlan([{ type: "say", message: "I do not know home yet. Use !bp sethome first." }]);
  }

  if (!hasCapability(context.world.capabilities, "go_to_position")) {
    return addressedPlan([{ type: "say", message: `I know home is at ${formatPosition(home.position)}, but navigation is unavailable.` }]);
  }

  return addressedPlan([
    { type: "say", message: `Heading home: ${formatPosition(home.position)}.` },
    {
      type: "action",
      action: {
        name: "go_to_position",
        args: {
          x: home.position.x,
          y: home.position.y,
          z: home.position.z,
          range: 1,
        },
      },
    },
  ]);
}

function createDigPlan(command: Extract<AgentCommand, { name: "dig" }>, context: PlannerContext): AgentPlan {
  if (!hasCapability(context.world.capabilities, "dig_nearest_block")) {
    return addressedPlan([{ type: "say", message: "I understood the dig request, but dig_nearest_block is unavailable." }]);
  }

  return addressedPlan([
    { type: "say", message: `Digging nearby ${command.blockName}.` },
    {
      type: "action",
      action: {
        name: "dig_nearest_block",
        args: {
          blockName: command.blockName,
          maxDistance: 6,
          count: 1,
        },
      },
    },
  ]);
}

function createDropItemPlan(command: Extract<AgentCommand, { name: "drop_item" }>, context: PlannerContext): AgentPlan {
  if (!hasCapability(context.world.capabilities, "drop_item")) {
    return addressedPlan([{ type: "say", message: "I understood the drop request, but drop_item is unavailable." }]);
  }

  const args: JsonRecord = {
    count: command.count ?? 1,
  };
  if (command.itemName) {
    args.itemName = command.itemName;
  }

  return addressedPlan([
    { type: "say", message: command.itemName ? `Dropping ${command.itemName}.` : "Dropping the held item." },
    {
      type: "action",
      action: {
        name: "drop_item",
        args,
      },
    },
  ]);
}

function createAttackPlan(command: Extract<AgentCommand, { name: "attack" }>, context: PlannerContext): AgentPlan {
  if (!hasCapability(context.world.capabilities, "attack_nearest_entity")) {
    return addressedPlan([{ type: "say", message: "I understood the attack request, but attack_nearest_entity is unavailable." }]);
  }

  const args: JsonRecord = {
    maxDistance: 8,
    allowPlayers: false,
    allowTrapped: false,
    follow: true,
  };
  if (command.targetName) {
    args.targetName = command.targetName;
  }

  return addressedPlan([
    { type: "say", message: command.targetName ? `Attacking nearest ${command.targetName}.` : "Attacking the nearest reachable hostile mob." },
    {
      type: "action",
      action: {
        name: "attack_nearest_entity",
        args,
      },
    },
  ]);
}

function createUseBlockPlan(command: Extract<AgentCommand, { name: "use_block" }>, context: PlannerContext): AgentPlan {
  if (!hasCapability(context.world.capabilities, "use_nearest_block")) {
    return addressedPlan([{ type: "say", message: "I understood the use request, but use_nearest_block is unavailable." }]);
  }

  return addressedPlan([
    { type: "say", message: `Using nearby ${command.blockName}.` },
    {
      type: "action",
      action: {
        name: "use_nearest_block",
        args: {
          blockName: command.blockName,
          maxDistance: 5,
        },
      },
    },
  ]);
}

function createInspectContainerPlan(context: PlannerContext): AgentPlan {
  if (!hasCapability(context.world.capabilities, "inspect_nearest_container")) {
    return addressedPlan([{ type: "say", message: "I understood the container request, but inspect_nearest_container is unavailable." }]);
  }

  return addressedPlan([
    { type: "say", message: "Checking the nearest container." },
    {
      type: "action",
      action: {
        name: "inspect_nearest_container",
        args: {
          maxDistance: 6,
        },
      },
    },
  ]);
}

function createCollectItemPlan(context: PlannerContext): AgentPlan {
  if (!hasCapability(context.world.capabilities, "collect_nearest_item")) {
    return addressedPlan([{ type: "say", message: "I understood the pickup request, but collect_nearest_item is unavailable." }]);
  }

  return addressedPlan([
    { type: "say", message: "Trying to pick up the nearest dropped item." },
    {
      type: "action",
      action: {
        name: "collect_nearest_item",
        args: {
          maxDistance: 16,
          timeoutMs: 8_000,
        },
      },
    },
  ]);
}

function createPlaceBlockPlan(command: Extract<AgentCommand, { name: "place_block" }>, context: PlannerContext): AgentPlan {
  if (!hasCapability(context.world.capabilities, "place_block")) {
    return addressedPlan([{ type: "say", message: "I understood the place request, but place_block is unavailable." }]);
  }

  return addressedPlan([
    { type: "say", message: `Placing ${command.itemName} at ${command.x}, ${command.y}, ${command.z}.` },
    {
      type: "action",
      action: {
        name: "place_block",
        args: {
          itemName: command.itemName,
          x: command.x,
          y: command.y,
          z: command.z,
        },
      },
    },
  ]);
}

function createCollectTaskPlan(context: PlannerContext): AgentPlan {
  if (!hasCapability(context.world.capabilities, "collect_nearest_item")) {
    return addressedPlan([{ type: "say", message: "I cannot queue collection because collect_nearest_item is unavailable." }]);
  }

  return addressedPlan([
    { type: "say", message: "Queued a short item collection task." },
    {
      type: "task",
      task: {
        title: "Collect nearby dropped items",
        source: "rule",
        steps: [
          createTaskAction("collect_nearest_item", { maxDistance: 16, timeoutMs: 8_000 }, "Collect nearest item"),
          { type: "wait", durationMs: 1_000, description: "Brief pause after pickup" },
          createTaskAction("collect_nearest_item", { maxDistance: 16, timeoutMs: 8_000 }, "Collect another nearby item"),
          { type: "wait", durationMs: 1_000, description: "Brief pause after pickup" },
          createTaskAction("collect_nearest_item", { maxDistance: 16, timeoutMs: 8_000 }, "Collect a final nearby item"),
          { type: "say", message: "Collection task finished." },
        ],
      },
    },
  ]);
}

function createStorageTaskPlan(context: PlannerContext): AgentPlan {
  if (!hasCapability(context.world.capabilities, "inspect_nearest_container")) {
    return addressedPlan([{ type: "say", message: "I cannot queue storage inspection because inspect_nearest_container is unavailable." }]);
  }

  return addressedPlan([
    { type: "say", message: "Queued a storage inspection task." },
    {
      type: "task",
      task: {
        title: "Inspect nearest storage",
        source: "rule",
        steps: [
          createTaskAction("inspect_nearest_container", { maxDistance: 6 }, "Inspect nearest container"),
          { type: "say", message: "Storage inspection task finished." },
        ],
      },
    },
  ]);
}

function createPatrolTaskPlan(context: PlannerContext): AgentPlan {
  const position = context.world.status.position;
  if (!position) {
    return addressedPlan([{ type: "say", message: "I cannot patrol because I do not know my current position." }]);
  }

  if (!hasCapability(context.world.capabilities, "go_to_position")) {
    return addressedPlan([{ type: "say", message: "I cannot patrol because go_to_position is unavailable." }]);
  }

  const y = Math.round(position.y);
  const points = [
    { x: Math.round(position.x + 6), y, z: Math.round(position.z) },
    { x: Math.round(position.x), y, z: Math.round(position.z + 6) },
    { x: Math.round(position.x - 6), y, z: Math.round(position.z) },
    { x: Math.round(position.x), y, z: Math.round(position.z) },
  ];

  return addressedPlan([
    { type: "say", message: "Queued a short patrol task." },
    {
      type: "task",
      task: {
        title: "Short local patrol",
        source: "rule",
        steps: points.flatMap((point, index) => [
          createTaskAction("go_to_position", { ...point, range: 1 }, `Patrol point ${index + 1}`),
          { type: "wait", durationMs: 8_000, description: "Wait while moving toward patrol point" } as const,
        ]),
      },
    },
  ]);
}

function createTaskAction(name: string, args: JsonRecord, description: string) {
  return {
    type: "action" as const,
    action: {
      name,
      args,
    },
    description,
  };
}

function formatPosition(position: { x: number; y: number; z: number }): string {
  return `${position.x}, ${position.y}, ${position.z}`;
}

function hasCapability(capabilities: BotCapability[], actionName: string): boolean {
  return capabilities.some((capability) => capability.name === actionName);
}

function isCommandBoundary(rest: string): boolean {
  return rest.length === 0 || /^[\s\uFF0C\u3002\uFF01\uFF1F,.!?]/u.test(rest);
}

function normalizeCommand(message: string): string {
  return normalizeSpacing(message).replace(/[\uFF0C\u3002\uFF01\uFF1F,.!?]/gu, "").trim();
}

function normalizeSpacing(message: string): string {
  return message.trim().toLowerCase().replace(/\s+/gu, " ");
}

function parseDigBlockName(command: string): string | undefined {
  for (const prefix of ["dig ", "mine ", "\u6316 "]) {
    if (!command.startsWith(prefix)) {
      continue;
    }

    return normalizeRequestedBlockName(command.slice(prefix.length), true);
  }

  return normalizeRequestedBlockName(command, false);
}

function parseUseBlockName(command: string): string | undefined {
  for (const prefix of ["use ", "activate ", "open ", "press ", "\u7528 ", "\u4F7F\u7528 ", "\u6253\u5F00 ", "\u6309 "]) {
    if (!command.startsWith(prefix)) {
      continue;
    }

    return normalizeRequestedBlockName(command.slice(prefix.length), true);
  }

  return undefined;
}

function parseDropCommand(command: string): { itemName?: string; count?: number } | undefined {
  for (const prefix of ["drop", "discard", "throw"]) {
    if (command === prefix) {
      return {};
    }

    if (command.startsWith(`${prefix} `)) {
      return parseDropTail(command.slice(prefix.length + 1));
    }
  }

  for (const prefix of ["\u4E22", "\u6254"]) {
    if (command === prefix) {
      return {};
    }

    if (command.startsWith(prefix)) {
      return parseDropTail(command.slice(prefix.length).trim());
    }
  }

  return undefined;
}

function parseDropTail(value: string): { itemName?: string; count?: number } {
  const parts = normalizeSpacing(value).split(" ").filter(Boolean);
  if (parts.length === 0) {
    return {};
  }

  let count: number | undefined;
  const first = Number.parseInt(parts[0] ?? "", 10);
  if (Number.isFinite(first) && String(first) === parts[0]) {
    count = clampInteger(first, 1, 64);
    parts.shift();
  }

  const last = Number.parseInt(parts[parts.length - 1] ?? "", 10);
  if (count === undefined && Number.isFinite(last) && String(last) === parts[parts.length - 1]) {
    count = clampInteger(last, 1, 64);
    parts.pop();
  }

  const itemName = normalizeRequestedItemName(parts.join(" "));
  const result: { itemName?: string; count?: number } = {};
  if (itemName) {
    result.itemName = itemName;
  }
  if (count !== undefined) {
    result.count = count;
  }
  return result;
}

function parseAttackCommand(command: string): { targetName?: string } | undefined {
  for (const prefix of ["attack", "hit", "fight"]) {
    if (command === prefix) {
      return {};
    }

    if (command.startsWith(`${prefix} `)) {
      return parseAttackTail(command.slice(prefix.length + 1));
    }
  }

  for (const prefix of ["\u653B\u51FB", "\u6253"]) {
    if (command === prefix) {
      return {};
    }

    if (command.startsWith(prefix)) {
      return parseAttackTail(command.slice(prefix.length).trim());
    }
  }

  return undefined;
}

function parseAttackTail(value: string): { targetName?: string } {
  const targetName = normalizeRequestedEntityName(value);
  return targetName ? { targetName } : {};
}

function parsePlaceCommand(command: string): { itemName: string; x: number; y: number; z: number } | undefined {
  const match = /^(?:place|put|\u653E\u7F6E|\u653E)\s+([a-z0-9_:\u4e00-\u9fa5]+)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)$/u.exec(command);
  if (!match?.[1] || !match[2] || !match[3] || !match[4]) {
    return undefined;
  }

  return {
    itemName: normalizePlaceItemName(match[1]),
    x: Number.parseFloat(match[2]),
    y: Number.parseFloat(match[3]),
    z: Number.parseFloat(match[4]),
  };
}

function normalizeRequestedItemName(value: string): string | undefined {
  const normalized = normalizeSpacing(value).replace(/^minecraft:/u, "").replace(/\s+/gu, "_");
  if (!normalized) {
    return undefined;
  }

  switch (normalized) {
    case "\u6CE5\u571F":
    case "\u571F":
      return "dirt";
    case "\u8349\u65B9\u5757":
      return "grass_block";
    case "\u77F3\u5934":
      return "stone";
    case "\u6728\u677F":
    case "planks":
      return "oak_planks";
    default:
      return normalized;
  }
}

function normalizeRequestedEntityName(value: string): string | undefined {
  const normalized = normalizeSpacing(value).replace(/^minecraft:/u, "").replace(/\s+/gu, "_");
  if (!normalized) {
    return undefined;
  }

  switch (normalized) {
    case "\u602A":
    case "\u602A\u7269":
      return "hostile";
    case "\u50F5\u5C38":
      return "zombie";
    case "\u82E6\u529B\u6015":
      return "creeper";
    case "\u9AB7\u9AC5":
    case "\u5C0F\u767D":
      return "skeleton";
    case "\u8718\u86DB":
      return "spider";
    default:
      return normalized;
  }
}

function normalizePlaceItemName(value: string): string {
  const normalized = normalizeSpacing(value).replace(/^minecraft:/u, "").replace(/\s+/gu, "_");
  switch (normalized) {
    case "\u6CE5\u571F":
    case "\u571F":
      return "dirt";
    case "\u8349\u65B9\u5757":
      return "grass_block";
    case "\u6728\u677F":
    case "planks":
      return "oak_planks";
    default:
      return normalized;
  }
}

function normalizeRequestedBlockName(value: string, allowUnknown: boolean): string | undefined {
  const normalized = normalizeSpacing(value).replace(/^minecraft:/u, "").replace(/\s+/gu, "_");
  switch (normalized) {
    case "\u6316\u6CE5\u571F":
    case "\u6316\u571F":
    case "\u6CE5\u571F":
    case "\u571F":
    case "dirt":
      return "dirt,grass_block";
    case "\u8349\u65B9\u5757":
    case "grass":
    case "grass_block":
      return "grass_block,dirt";
    case "\u77F3\u5934":
    case "stone":
      return "stone";
    case "\u95E8":
    case "door":
      return "door";
    case "\u6309\u94AE":
    case "button":
      return "button";
    case "\u62C9\u6746":
    case "lever":
      return "lever";
    case "\u7BB1\u5B50":
    case "chest":
      return "chest";
    case "\u6728\u677F":
    case "planks":
      return "oak_planks";
    default:
      return allowUnknown && normalized ? normalized : undefined;
  }
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
