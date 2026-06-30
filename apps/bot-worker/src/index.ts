import {
  asErrorMessage,
  BLOCKPILOT_PROTOCOL_VERSION,
  createId,
  isGatewayCommandMessage,
  isRecord,
  nowIso,
  safeJsonParse,
  type ActionResult,
  type BlockPilotEvent,
  type BotAction,
  type BotConnectionState,
  type BotStatus,
  type BotTaskSnapshot,
  type BotTaskState,
  type GatewayToWorkerMessage,
  type ChatMessageSnapshot,
  type DangerLevel,
  type JsonRecord,
  type WorkerToGatewayMessage,
  type WorldSnapshot,
} from "@blockpilot/core";
import { loadDotEnv } from "@blockpilot/node-env";
import { createBot, type Bot, type BotOptions } from "mineflayer";
import pathfinderPackage from "mineflayer-pathfinder";
import { WebSocket, type RawData } from "ws";
import { PluginRuntime } from "./plugin-runtime.js";
import { builtInPlugins } from "./plugins/index.js";

const { goals, Movements, pathfinder } = pathfinderPackage;

loadDotEnv();

type AuthMode = NonNullable<BotOptions["auth"]>;
type PathfinderGoal = InstanceType<(typeof goals)["GoalFollow"]> | InstanceType<(typeof goals)["GoalNear"]>;
type InventoryWindow = Bot["inventory"];
type MineflayerBlock = NonNullable<ReturnType<Bot["blockAt"]>>;
type MineflayerEntity = Bot["entity"];
type MineflayerItem = NonNullable<Bot["heldItem"]>;
type MineflayerVec3 = MineflayerEntity["position"];
type SnapshotVec3 = NonNullable<BotStatus["position"]>;

interface PathfinderController {
  setMovements: (movements: InstanceType<typeof Movements>) => void;
  setGoal: (goal: PathfinderGoal | null, dynamic?: boolean) => void;
  stop: () => void;
}

type PathfinderBot = Bot & {
  pathfinder: PathfinderController;
};

interface WorkerConfig {
  botId: string;
  gatewayUrl: string;
  mcHost: string;
  mcPort: number;
  username: string;
  auth: AuthMode;
  version?: string;
}

const ENTITY_SCAN_RADIUS = 32;
const BLOCK_SCAN_RADIUS = 12;
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
const PASSIVE_ENTITY_NAMES = new Set([
  "allay",
  "armadillo",
  "axolotl",
  "bat",
  "bee",
  "camel",
  "cat",
  "chicken",
  "cod",
  "cow",
  "dolphin",
  "donkey",
  "fox",
  "frog",
  "glow_squid",
  "goat",
  "horse",
  "iron_golem",
  "llama",
  "mooshroom",
  "mule",
  "ocelot",
  "panda",
  "parrot",
  "pig",
  "polar_bear",
  "pufferfish",
  "rabbit",
  "salmon",
  "sheep",
  "sniffer",
  "snow_golem",
  "squid",
  "strider",
  "tadpole",
  "tropical_fish",
  "turtle",
  "villager",
  "wandering_trader",
  "wolf",
]);
const ITEM_ENTITY_NAMES = new Set(["item", "experience_orb"]);
const CONTAINER_BLOCK_NAMES = new Set([
  "barrel",
  "chest",
  "dispenser",
  "dropper",
  "hopper",
  "shulker_box",
  "trapped_chest",
]);
const UTILITY_BLOCK_NAMES = new Set([
  "anvil",
  "blast_furnace",
  "brewing_stand",
  "cartography_table",
  "crafting_table",
  "enchanting_table",
  "furnace",
  "grindstone",
  "lectern",
  "loom",
  "smithing_table",
  "smoker",
  "stonecutter",
]);
const DANGER_BLOCK_NAMES = new Set([
  "cactus",
  "campfire",
  "fire",
  "lava",
  "magma_block",
  "powder_snow",
  "soul_campfire",
  "soul_fire",
  "sweet_berry_bush",
]);
const SPAWNER_BLOCK_NAMES = new Set(["spawner", "trial_spawner"]);

const config = readConfig();

let bot: Bot | undefined;
let gateway: WebSocket | undefined;
let connectionState: BotConnectionState = "connecting";
let connectedAt: string | undefined;
let lastError: string | undefined;
let shuttingDown = false;
let gatewayReconnectTimer: ReturnType<typeof setTimeout> | undefined;
const recentChat: ChatMessageSnapshot[] = [];
const recentTasks: BotTaskSnapshot[] = [];
let currentTask: BotTaskSnapshot | undefined;

const pluginRuntime = new PluginRuntime({
  config: {
    botId: config.botId,
    username: config.username,
  },
  emitEvent: publishEvent,
  logger: {
    error: (message) => console.error(message),
    info: (message) => console.log(message),
    warn: (message) => console.warn(message),
  },
  minecraft: {
    chat: (message) => {
      bot?.chat(message);
    },
    followPlayer: (playerName, distance) => followPlayer(requireBot(), playerName, distance),
    goToPosition: (x, y, z, range) => goToPosition(requireBot(), x, y, z, range),
    requireBot,
    stopCurrentControls: (reason) => {
      stopCurrentControls(requireBot(), reason);
    },
  },
  world: {
    getSnapshot: createWorldSnapshot,
  },
});

await pluginRuntime.load(builtInPlugins);

console.log(`[bot-worker] starting '${config.botId}'`);
console.log(`[bot-worker] gateway: ${config.gatewayUrl}`);
console.log(`[bot-worker] minecraft: ${config.mcHost}:${config.mcPort} as ${config.username}`);

connectGateway();
connectMinecraft();

const statusTimer = setInterval(() => {
  publishStatus();
  publishWorldSnapshot();
}, 5_000);

statusTimer.unref();

process.once("SIGINT", () => {
  shutdown("SIGINT");
});

process.once("SIGTERM", () => {
  shutdown("SIGTERM");
});

function connectGateway(): void {
  if (gatewayReconnectTimer) {
    clearTimeout(gatewayReconnectTimer);
    gatewayReconnectTimer = undefined;
  }

  gateway = new WebSocket(config.gatewayUrl);

  gateway.on("open", () => {
    console.log("[bot-worker] connected to gateway");

    sendToGateway({
      type: "worker.hello",
      protocolVersion: BLOCKPILOT_PROTOCOL_VERSION,
      botId: config.botId,
      workerName: "blockpilot-bot-worker",
      capabilities: pluginRuntime.listCapabilities(),
    });
    publishStatus();
  });

  gateway.on("message", (data) => {
    handleGatewayMessage(data);
  });

  gateway.on("close", () => {
    console.warn("[bot-worker] gateway disconnected");

    if (!shuttingDown) {
      gatewayReconnectTimer = setTimeout(connectGateway, 2_000);
      gatewayReconnectTimer.unref();
    }
  });

  gateway.on("error", (error) => {
    console.warn(`[bot-worker] gateway error: ${error.message}`);
  });
}

function connectMinecraft(): void {
  const options: BotOptions = {
    host: config.mcHost,
    port: config.mcPort,
    username: config.username,
    auth: config.auth,
  };

  if (config.version) {
    options.version = config.version;
  }

  bot = createBot(options);
  bot.loadPlugin(pathfinder);

  bot.once("spawn", () => {
    connectionState = "online";
    connectedAt = connectedAt ?? nowIso();
    lastError = undefined;
    configurePathfinder(requirePathfinderBot(bot));
    console.log("[bot-worker] spawned in Minecraft server");
    publishEvent("bot.spawn", "Bot spawned in Minecraft server");
    publishStatus();
  });

  bot.on("chat", (username, message) => {
    if (username === bot?.username) {
      return;
    }

    publishEvent("chat.message", `${username}: ${message}`, {
      username,
      message,
    });
    rememberChat(username, message);

    void pluginRuntime.emitChat({
      username,
      message,
    });
  });

  bot.on("health", () => {
    publishStatus();
  });

  bot.on("death", () => {
    publishEvent("bot.death", "Bot died");
    publishStatus();
  });

  bot.on("kicked", (reason) => {
    const message = typeof reason === "string" ? reason : JSON.stringify(reason);
    connectionState = "offline";
    lastError = `Kicked: ${message}`;
    publishEvent("bot.kicked", lastError);
    publishStatus();
  });

  bot.on("end", (reason) => {
    connectionState = "offline";
    publishEvent("bot.end", `Minecraft connection ended: ${String(reason ?? "unknown")}`);
    publishStatus();
  });

  bot.on("error", (error) => {
    connectionState = "errored";
    lastError = error.message;
    publishEvent("bot.error", error.message);
    publishStatus();
  });
}

function handleGatewayMessage(data: RawData): void {
  const parsed = safeJsonParse(data.toString());

  if (isRecord(parsed) && parsed.type === "gateway.ack") {
    console.log(`[bot-worker] gateway ack: ${String(parsed.message ?? "ok")}`);
    return;
  }

  if (!isGatewayCommandMessage(parsed)) {
    console.warn("[bot-worker] ignored invalid gateway message");
    return;
  }

  void runCommand(parsed).catch((error) => {
    sendToGateway({
      type: "worker.result",
      requestId: parsed.requestId,
      ok: false,
      error: asErrorMessage(error),
    });
  });
}

async function runCommand(message: Extract<GatewayToWorkerMessage, { type: "gateway.command" }>): Promise<void> {
  const action = message.action;
  const previousTask = currentTask;

  if (action.name === "stop" && previousTask?.state === "running") {
    cancelTask(previousTask, "Stopped by stop action");
  }

  if (isLongRunningAction(action) && previousTask?.state === "running") {
    cancelTask(previousTask, `Replaced by '${action.name}'`);
  }

  const task = startTask(action, isLongRunningAction(action));

  try {
    const result = await pluginRuntime.execute(action);

    if (isLongRunningAction(action)) {
      updateTask(task, "running", result.message);
    } else {
      finishTask(task, "completed", result.message);
    }

    const resultWithTask = attachTaskResult(result, task);

    sendToGateway({
      type: "worker.result",
      requestId: message.requestId,
      ok: true,
      result: resultWithTask,
    });
  } catch (error) {
    failTask(task, asErrorMessage(error));
    sendToGateway({
      type: "worker.result",
      requestId: message.requestId,
      ok: false,
      error: asErrorMessage(error),
    });
  }
}

function isLongRunningAction(action: BotAction): boolean {
  return action.name === "follow_player";
}

function startTask(action: BotAction, setAsCurrent: boolean): BotTaskSnapshot {
  const task: BotTaskSnapshot = {
    taskId: createId("task"),
    botId: config.botId,
    actionName: action.name,
    state: "running",
    startedAt: nowIso(),
    updatedAt: nowIso(),
  };

  if (action.args) {
    task.args = action.args;
  }

  rememberTask(task);

  if (setAsCurrent) {
    currentTask = task;
  }

  publishTask(task);
  return task;
}

function updateTask(task: BotTaskSnapshot, state: BotTaskState, message?: string): void {
  task.state = state;
  task.updatedAt = nowIso();

  if (message) {
    task.message = message;
  }

  publishTask(task);
  publishWorldSnapshot();
}

function finishTask(task: BotTaskSnapshot, state: Exclude<BotTaskState, "running">, message?: string): void {
  task.completedAt = nowIso();
  updateTask(task, state, message);

  if (currentTask?.taskId === task.taskId) {
    currentTask = undefined;
    publishWorldSnapshot();
  }
}

function failTask(task: BotTaskSnapshot, error: string): void {
  task.error = error;
  finishTask(task, "failed", error);
}

function cancelTask(task: BotTaskSnapshot, message?: string): void {
  if (task.state !== "running") {
    return;
  }

  finishTask(task, "cancelled", message);
}

function attachTaskResult(result: ActionResult, task: BotTaskSnapshot): ActionResult {
  return {
    ...result,
    data: {
      ...(result.data ?? {}),
      taskId: task.taskId,
      taskState: task.state,
    },
  };
}

async function followPlayer(activeBot: Bot, playerName: string, distance = 2): Promise<ActionResult> {
  const target = activeBot.players[playerName]?.entity;
  if (!target) {
    throw new Error(`Player '${playerName}' is not visible to the bot`);
  }

  const followDistance = clamp(distance, 1, 16);
  const pathfinderBot = requirePathfinderBot(activeBot);
  stopCurrentControls(activeBot, `Starting follow_player for '${playerName}'`);

  pathfinderBot.pathfinder.setGoal(new goals.GoalFollow(target, followDistance), true);

  publishEvent("action.follow_player", `Following player '${playerName}'`, {
    playerName,
    distance: followDistance,
  });

  return {
    ok: true,
    message: `Following player '${playerName}'`,
    data: {
      playerName,
      distance: followDistance,
    },
  };
}

async function goToPosition(activeBot: Bot, x: number, y: number, z: number, range = 1): Promise<ActionResult> {
  const arrivalRange = clamp(range, 0, 8);
  const pathfinderBot = requirePathfinderBot(activeBot);
  stopCurrentControls(activeBot, `Starting go_to_position to ${round(x)}, ${round(y)}, ${round(z)}`);

  pathfinderBot.pathfinder.setGoal(new goals.GoalNear(x, y, z, arrivalRange), false);

  publishEvent("action.go_to_position", `Going to ${round(x)}, ${round(y)}, ${round(z)}`, {
    x,
    y,
    z,
    range: arrivalRange,
  });

  return {
    ok: true,
    message: `Going to ${round(x)}, ${round(y)}, ${round(z)}`,
    data: {
      x,
      y,
      z,
      range: arrivalRange,
    },
  };
}

function configurePathfinder(activeBot: PathfinderBot): void {
  activeBot.pathfinder.setMovements(new Movements(activeBot));
}

function stopCurrentControls(activeBot: Bot, reason?: string): void {
  activeBot.clearControlStates();

  const maybePathfinder = activeBot as Bot & {
    pathfinder?: {
      setGoal?: (goal: null) => void;
      stop?: () => void;
    };
  };

  maybePathfinder.pathfinder?.stop?.();
  maybePathfinder.pathfinder?.setGoal?.(null);

  if (reason) {
    publishEvent("action.stop", reason);
  }
}

function requireBot(): Bot {
  if (!bot) {
    throw new Error("Minecraft bot has not been created");
  }

  if (connectionState !== "online") {
    throw new Error(`Minecraft bot is not online; current state is '${connectionState}'`);
  }

  return bot;
}

function requirePathfinderBot(activeBot: Bot | undefined): PathfinderBot {
  if (!activeBot) {
    throw new Error("Minecraft bot has not been created");
  }

  const maybePathfinderBot = activeBot as Bot & {
    pathfinder?: PathfinderController;
  };

  if (!maybePathfinderBot.pathfinder) {
    throw new Error("Pathfinder plugin is not available");
  }

  return maybePathfinderBot as PathfinderBot;
}

function publishStatus(): void {
  sendToGateway({
    type: "worker.status",
    status: createStatus(),
  });
}

function publishWorldSnapshot(): void {
  sendToGateway({
    type: "worker.world",
    snapshot: createWorldSnapshot(),
  });
}

function publishTask(task: BotTaskSnapshot): void {
  sendToGateway({
    type: "worker.task",
    task: cloneTask(task),
  });
}

function publishEvent(kind: string, message?: string, payload?: JsonRecord): void {
  const event: BlockPilotEvent = {
    id: createId("evt"),
    botId: config.botId,
    kind,
    createdAt: nowIso(),
  };

  if (message) {
    event.message = message;
  }

  if (payload) {
    event.payload = payload;
  }

  sendToGateway({
    type: "worker.event",
    event,
  });
}

function createWorldSnapshot(): WorldSnapshot {
  const entities = createEntitySnapshots();
  const blocks = createBlockSnapshots();
  const self = createSelfSnapshot();
  const snapshot: WorldSnapshot = {
    botId: config.botId,
    updatedAt: nowIso(),
    status: createStatus(),
    capabilities: pluginRuntime.listCapabilities(),
    recentTasks: recentTasks.map((task) => cloneTask(task)),
    nearbyPlayers: createNearbyPlayerSnapshots(),
    recentChat: [...recentChat],
    entities,
    blocks,
    self,
    safety: createSafetySnapshot(entities, blocks, self),
  };

  if (currentTask) {
    snapshot.currentTask = cloneTask(currentTask);
  }

  return snapshot;
}

function createNearbyPlayerSnapshots(): WorldSnapshot["nearbyPlayers"] {
  const activeBot = bot;
  const botPosition = activeBot?.entity?.position;

  if (!activeBot) {
    return [];
  }

  return Object.entries(activeBot.players)
    .filter(([username, player]) => username !== activeBot.username && Boolean(player.entity))
    .map(([username, player]) => {
      const position = player.entity?.position;
      const snapshot: WorldSnapshot["nearbyPlayers"][number] = {
        username,
      };

      if (position) {
        snapshot.position = {
          x: round(position.x),
          y: round(position.y),
          z: round(position.z),
        };
      }

      const velocity = player.entity?.velocity;
      if (velocity) {
        snapshot.velocity = toVec3Snapshot(velocity);
      }

      if (position && botPosition) {
        snapshot.distance = round(position.distanceTo(botPosition));
      }

      return snapshot;
    })
    .sort((a, b) => (a.distance ?? Number.POSITIVE_INFINITY) - (b.distance ?? Number.POSITIVE_INFINITY))
    .slice(0, 16);
}

function createEntitySnapshots(): WorldSnapshot["entities"] {
  const activeBot = bot;
  const botPosition = activeBot?.entity?.position;
  const entities: WorldSnapshot["entities"] = {
    mobs: [],
    animals: [],
    items: [],
    others: [],
  };

  if (!activeBot || !botPosition) {
    return entities;
  }

  for (const entity of Object.values(activeBot.entities)) {
    if (!entity.position || entity.id === activeBot.entity.id) {
      continue;
    }

    const distance = entity.position.distanceTo(botPosition);
    if (distance > ENTITY_SCAN_RADIUS) {
      continue;
    }

    const snapshot = createEntitySnapshot(entity, botPosition);
    switch (snapshot.kind) {
      case "hostile":
        entities.mobs.push(snapshot);
        break;
      case "passive":
        entities.animals.push(snapshot);
        break;
      case "item":
        entities.items.push(snapshot);
        break;
      case "other":
        entities.others.push(snapshot);
        break;
    }
  }

  sortByDistance(entities.mobs);
  sortByDistance(entities.animals);
  sortByDistance(entities.items);
  sortByDistance(entities.others);

  entities.mobs = entities.mobs.slice(0, 24);
  entities.animals = entities.animals.slice(0, 24);
  entities.items = entities.items.slice(0, 24);
  entities.others = entities.others.slice(0, 16);

  return entities;
}

function createEntitySnapshot(entity: MineflayerEntity, botPosition: MineflayerVec3): WorldSnapshot["entities"]["mobs"][number] {
  const name = entity.name ?? entity.mobType ?? entity.objectType ?? entity.type ?? "unknown";
  const snapshot: WorldSnapshot["entities"]["mobs"][number] = {
    id: entity.id,
    name,
    kind: classifyEntity(entity),
    position: toVec3Snapshot(entity.position),
    distance: round(entity.position.distanceTo(botPosition)),
  };

  if (entity.displayName) {
    snapshot.displayName = entity.displayName;
  }

  if (entity.username) {
    snapshot.username = entity.username;
  }

  if (entity.velocity) {
    snapshot.velocity = toVec3Snapshot(entity.velocity);
  }

  return snapshot;
}

function classifyEntity(entity: MineflayerEntity): WorldSnapshot["entities"]["mobs"][number]["kind"] {
  const name = entity.name ?? entity.mobType ?? entity.objectType ?? "";

  if (entity.type === "player") {
    return "other";
  }

  if (ITEM_ENTITY_NAMES.has(name) || entity.type === "orb") {
    return "item";
  }

  if (entity.type === "hostile" || HOSTILE_ENTITY_NAMES.has(name)) {
    return "hostile";
  }

  if (PASSIVE_ENTITY_NAMES.has(name)) {
    return "passive";
  }

  return "other";
}

function createBlockSnapshots(): WorldSnapshot["blocks"] {
  const activeBot = bot;
  const botPosition = activeBot?.entity?.position;
  const blocks: WorldSnapshot["blocks"] = {
    nearbyUtilityBlocks: [],
    nearbyDangerBlocks: [],
    nearbyContainers: [],
    nearbySpawners: [],
  };

  if (!activeBot || !botPosition) {
    return blocks;
  }

  const positions = activeBot.findBlocks({
    point: botPosition,
    matching: (block) => isTrackedBlock(block.name),
    maxDistance: BLOCK_SCAN_RADIUS,
    count: 128,
  });

  for (const position of positions) {
    const block = activeBot.blockAt(position);
    if (!block) {
      continue;
    }

    if (isUtilityBlock(block.name)) {
      blocks.nearbyUtilityBlocks.push(createBlockSnapshot(block, "utility", botPosition));
    }

    if (isDangerBlock(block.name)) {
      blocks.nearbyDangerBlocks.push(createBlockSnapshot(block, "danger", botPosition));
    }

    if (isContainerBlock(block.name)) {
      blocks.nearbyContainers.push(createBlockSnapshot(block, "container", botPosition));
    }

    if (isSpawnerBlock(block.name)) {
      blocks.nearbySpawners.push(createBlockSnapshot(block, "spawner", botPosition));
    }
  }

  sortByDistance(blocks.nearbyUtilityBlocks);
  sortByDistance(blocks.nearbyDangerBlocks);
  sortByDistance(blocks.nearbyContainers);
  sortByDistance(blocks.nearbySpawners);

  blocks.nearbyUtilityBlocks = blocks.nearbyUtilityBlocks.slice(0, 24);
  blocks.nearbyDangerBlocks = blocks.nearbyDangerBlocks.slice(0, 24);
  blocks.nearbyContainers = blocks.nearbyContainers.slice(0, 24);
  blocks.nearbySpawners = blocks.nearbySpawners.slice(0, 12);

  return blocks;
}

function createBlockSnapshot(
  block: MineflayerBlock,
  kind: WorldSnapshot["blocks"]["nearbyUtilityBlocks"][number]["kind"],
  botPosition: MineflayerVec3,
): WorldSnapshot["blocks"]["nearbyUtilityBlocks"][number] {
  return {
    name: block.name,
    displayName: block.displayName,
    kind,
    position: toVec3Snapshot(block.position),
    distance: round(block.position.distanceTo(botPosition)),
  };
}

function createSelfSnapshot(): WorldSnapshot["self"] {
  const activeBot = bot;
  const self: WorldSnapshot["self"] = {
    inventory: [],
    equipment: [],
  };

  if (!activeBot) {
    return self;
  }

  if (typeof activeBot.health === "number") {
    self.health = activeBot.health;
  }

  if (typeof activeBot.food === "number") {
    self.food = activeBot.food;
  }

  if (typeof activeBot.oxygenLevel === "number") {
    self.oxygenLevel = activeBot.oxygenLevel;
  }

  if (activeBot.heldItem) {
    self.heldItem = createInventoryItemSnapshot(activeBot.heldItem);
  }

  self.inventory = activeBot.inventory.items().map((item) => createInventoryItemSnapshot(item));
  self.equipment = createEquipmentSnapshots(activeBot.inventory, activeBot.heldItem);

  return self;
}

function createEquipmentSnapshots(inventory: InventoryWindow, heldItem: MineflayerItem | null): WorldSnapshot["self"]["equipment"] {
  const equipment: WorldSnapshot["self"]["equipment"] = [];

  if (heldItem) {
    equipment.push({
      ...createInventoryItemSnapshot(heldItem),
      slotName: "hand",
    });
  }

  const slotMap: Array<[number, WorldSnapshot["self"]["equipment"][number]["slotName"]]> = [
    [5, "head"],
    [6, "torso"],
    [7, "legs"],
    [8, "feet"],
    [45, "off-hand"],
  ];

  for (const [slot, slotName] of slotMap) {
    const item = inventory.slots[slot];
    if (!item) {
      continue;
    }

    equipment.push({
      ...createInventoryItemSnapshot(item),
      slotName,
    });
  }

  return equipment;
}

function createInventoryItemSnapshot(item: MineflayerItem): WorldSnapshot["self"]["inventory"][number] {
  const snapshot: WorldSnapshot["self"]["inventory"][number] = {
    name: item.name,
    count: item.count,
  };

  if (item.displayName) {
    snapshot.displayName = item.displayName;
  }

  if (typeof item.slot === "number") {
    snapshot.slot = item.slot;
  }

  if (item.durabilityUsed > 0) {
    snapshot.durabilityUsed = item.durabilityUsed;
  }

  if (item.maxDurability > 0) {
    snapshot.maxDurability = item.maxDurability;
  }

  return snapshot;
}

function createSafetySnapshot(
  entities: WorldSnapshot["entities"],
  blocks: WorldSnapshot["blocks"],
  self: WorldSnapshot["self"],
): WorldSnapshot["safety"] {
  const threats: WorldSnapshot["safety"]["threats"] = [];
  const reasons: string[] = [];

  if (typeof self.health === "number" && self.health <= 6) {
    threats.push({
      kind: "status",
      name: "low_health",
      severity: self.health <= 3 ? "critical" : "danger",
      reason: `Health is low (${self.health}).`,
    });
  }

  if (typeof self.food === "number" && self.food <= 6) {
    threats.push({
      kind: "status",
      name: "low_food",
      severity: self.food <= 2 ? "danger" : "watch",
      reason: `Food is low (${self.food}).`,
    });
  }

  if (typeof self.oxygenLevel === "number" && self.oxygenLevel <= 6) {
    threats.push({
      kind: "status",
      name: "low_oxygen",
      severity: self.oxygenLevel <= 2 ? "critical" : "danger",
      reason: `Oxygen is low (${self.oxygenLevel}).`,
    });
  }

  for (const block of blocks.nearbyDangerBlocks) {
    if ((block.distance ?? Number.POSITIVE_INFINITY) > 5) {
      continue;
    }

    const threat: WorldSnapshot["safety"]["threats"][number] = {
      kind: "block",
      name: block.name,
      severity: getDangerBlockSeverity(block),
      reason: `${block.displayName ?? block.name} is nearby.`,
      position: block.position,
    };

    if (block.distance !== undefined) {
      threat.distance = block.distance;
    }

    threats.push(threat);
  }

  for (const entity of entities.mobs) {
    const threat = assessHostileEntity(entity, blocks);
    threats.push(threat);
  }

  const dangerLevel = getHighestDangerLevel(threats.map((threat) => threat.severity));
  if (dangerLevel === "safe") {
    reasons.push("No immediate threats detected.");
  } else {
    reasons.push(...threats.map((threat) => threat.reason).slice(0, 8));
  }

  return {
    dangerLevel,
    threats: threats.sort((a, b) => compareDangerLevel(b.severity, a.severity)).slice(0, 16),
    reasons,
  };
}

function assessHostileEntity(
  entity: WorldSnapshot["entities"]["mobs"][number],
  blocks: WorldSnapshot["blocks"],
): WorldSnapshot["safety"]["threats"][number] {
  const distance = entity.distance ?? Number.POSITIVE_INFINITY;
  const containmentReason = getEntityContainmentReason(entity, blocks);
  const trapped = Boolean(containmentReason);
  const verticalDelta = Math.abs((entity.position?.y ?? 0) - (bot?.entity?.position.y ?? 0));
  const canReachBot = !trapped && distance <= 14 && verticalDelta <= 4;
  let severity: DangerLevel = "watch";
  let reason = `${entity.displayName ?? entity.name} is nearby.`;

  if (containmentReason === "near_spawner") {
    reason = `${entity.displayName ?? entity.name} is near a spawner and likely part of a farm setup.`;
  } else if (containmentReason === "vertical_separation") {
    reason = `${entity.displayName ?? entity.name} is vertically separated from the bot and likely cannot reach it now.`;
  } else if (canReachBot && distance <= 4) {
    severity = "critical";
    reason = `${entity.displayName ?? entity.name} is very close and can likely reach the bot.`;
  } else if (canReachBot && distance <= 10) {
    severity = "danger";
    reason = `${entity.displayName ?? entity.name} can likely reach the bot.`;
  } else if (canReachBot) {
    severity = "watch";
    reason = `${entity.displayName ?? entity.name} may be able to reach the bot.`;
  }

  const threat: WorldSnapshot["safety"]["threats"][number] = {
    kind: "entity",
    name: entity.name,
    severity,
    reason,
    trapped,
    canReachBot,
  };

  if (containmentReason) {
    threat.containmentReason = containmentReason;
  }

  if (entity.position) {
    threat.position = entity.position;
  }

  if (entity.distance !== undefined) {
    threat.distance = entity.distance;
  }

  return threat;
}

function getEntityContainmentReason(
  entity: WorldSnapshot["entities"]["mobs"][number],
  blocks: WorldSnapshot["blocks"],
): string | undefined {
  const entityPosition = entity.position;
  if (!entityPosition) {
    return undefined;
  }

  const nearSpawner = blocks.nearbySpawners.some((block) => distanceBetween(block.position, entityPosition) <= 8);
  if (nearSpawner) {
    return "near_spawner";
  }

  const botPosition = bot?.entity?.position;
  const verticallySeparated = botPosition ? Math.abs(entityPosition.y - botPosition.y) > 4 : false;
  if (verticallySeparated) {
    return "vertical_separation";
  }

  return undefined;
}

function getDangerBlockSeverity(block: WorldSnapshot["blocks"]["nearbyDangerBlocks"][number]): DangerLevel {
  const distance = block.distance ?? Number.POSITIVE_INFINITY;

  if (block.name.includes("lava") || block.name === "fire" || block.name === "soul_fire") {
    return distance <= 2 ? "critical" : "danger";
  }

  return distance <= 2 ? "danger" : "watch";
}

function getHighestDangerLevel(levels: DangerLevel[]): DangerLevel {
  return levels.reduce<DangerLevel>((highest, level) => (compareDangerLevel(level, highest) > 0 ? level : highest), "safe");
}

function compareDangerLevel(left: DangerLevel, right: DangerLevel): number {
  return dangerRank(left) - dangerRank(right);
}

function dangerRank(level: DangerLevel): number {
  switch (level) {
    case "safe":
      return 0;
    case "watch":
      return 1;
    case "danger":
      return 2;
    case "critical":
      return 3;
  }
}

function isTrackedBlock(name: string): boolean {
  return isUtilityBlock(name) || isDangerBlock(name) || isContainerBlock(name) || isSpawnerBlock(name);
}

function isUtilityBlock(name: string): boolean {
  return UTILITY_BLOCK_NAMES.has(name) || name.endsWith("_bed") || name === "bed";
}

function isDangerBlock(name: string): boolean {
  return DANGER_BLOCK_NAMES.has(name) || name.includes("lava") || name.endsWith("_fire");
}

function isContainerBlock(name: string): boolean {
  return CONTAINER_BLOCK_NAMES.has(name) || name.endsWith("_shulker_box");
}

function isSpawnerBlock(name: string): boolean {
  return SPAWNER_BLOCK_NAMES.has(name) || name.endsWith("spawner");
}

function toVec3Snapshot(position: MineflayerVec3): SnapshotVec3 {
  return {
    x: round(position.x),
    y: round(position.y),
    z: round(position.z),
  };
}

function distanceBetween(left: SnapshotVec3, right: SnapshotVec3): number {
  return Math.sqrt((left.x - right.x) ** 2 + (left.y - right.y) ** 2 + (left.z - right.z) ** 2);
}

function sortByDistance<T extends { distance?: number }>(values: T[]): void {
  values.sort((a, b) => (a.distance ?? Number.POSITIVE_INFINITY) - (b.distance ?? Number.POSITIVE_INFINITY));
}

function createStatus(): BotStatus {
  const status: BotStatus = {
    botId: config.botId,
    state: connectionState,
    updatedAt: nowIso(),
  };

  const activeBot = bot;
  if (activeBot?.username) {
    status.username = activeBot.username;
  } else {
    status.username = config.username;
  }

  if (connectedAt) {
    status.connectedAt = connectedAt;
  }

  if (typeof activeBot?.health === "number") {
    status.health = activeBot.health;
  }

  if (typeof activeBot?.food === "number") {
    status.food = activeBot.food;
  }

  const position = activeBot?.entity?.position;
  if (position) {
    status.position = {
      x: round(position.x),
      y: round(position.y),
      z: round(position.z),
    };
  }

  if (activeBot?.game?.dimension) {
    status.dimension = activeBot.game.dimension;
  }

  if (activeBot?.game?.gameMode) {
    status.gameMode = activeBot.game.gameMode;
  }

  if (lastError) {
    status.lastError = lastError;
  }

  return status;
}

function rememberChat(username: string, message: string): void {
  recentChat.push({
    username,
    message,
    receivedAt: nowIso(),
  });

  if (recentChat.length > 20) {
    recentChat.splice(0, recentChat.length - 20);
  }
}

function rememberTask(task: BotTaskSnapshot): void {
  recentTasks.push(task);

  if (recentTasks.length > 20) {
    recentTasks.splice(0, recentTasks.length - 20);
  }
}

function cloneTask(task: BotTaskSnapshot): BotTaskSnapshot {
  const clone: BotTaskSnapshot = { ...task };

  if (task.args) {
    clone.args = { ...task.args };
  }

  return clone;
}

function sendToGateway(message: WorkerToGatewayMessage): void {
  if (gateway?.readyState !== WebSocket.OPEN) {
    return;
  }

  gateway.send(JSON.stringify(message));
}

function readConfig(): WorkerConfig {
  const mcHost = process.env.MC_HOST;
  if (!mcHost) {
    console.error("[bot-worker] Missing MC_HOST. Example: MC_HOST=127.0.0.1");
    process.exit(1);
  }

  const username = process.env.MC_USERNAME ?? "BlockPilot";

  const configBase: WorkerConfig = {
    botId: process.env.BLOCKPILOT_BOT_ID ?? username,
    gatewayUrl: process.env.BLOCKPILOT_GATEWAY_URL ?? "ws://127.0.0.1:8787/worker",
    mcHost,
    mcPort: readInteger(process.env.MC_PORT, 25565),
    username,
    auth: readAuthMode(process.env.MC_AUTH),
  };

  if (process.env.MC_VERSION) {
    configBase.version = process.env.MC_VERSION;
  }

  return configBase;
}

function readAuthMode(value: string | undefined): AuthMode {
  if (value === "microsoft" || value === "mojang" || value === "offline") {
    return value;
  }

  return "offline";
}

function readInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function shutdown(signal: string): void {
  shuttingDown = true;
  console.log(`[bot-worker] shutting down after ${signal}`);
  publishEvent("worker.shutdown", `Worker shutting down after ${signal}`);

  if (gatewayReconnectTimer) {
    clearTimeout(gatewayReconnectTimer);
  }

  gateway?.close();
  bot?.quit("BlockPilot worker shutdown");

  setTimeout(() => {
    process.exit(0);
  }, 500).unref();
}
