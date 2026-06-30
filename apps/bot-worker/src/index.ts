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
  type BotConnectionState,
  type BotStatus,
  type GatewayToWorkerMessage,
  type JsonRecord,
  type WorkerToGatewayMessage,
} from "@blockpilot/core";
import { createBot, type Bot, type BotOptions } from "mineflayer";
import { goals, Movements, pathfinder } from "mineflayer-pathfinder";
import { WebSocket, type RawData } from "ws";

type AuthMode = NonNullable<BotOptions["auth"]>;
type Goal = InstanceType<(typeof goals)["GoalFollow"]>;

interface PathfinderController {
  setMovements: (movements: Movements) => void;
  setGoal: (goal: Goal | null, dynamic?: boolean) => void;
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

const config = readConfig();

let bot: Bot | undefined;
let gateway: WebSocket | undefined;
let connectionState: BotConnectionState = "connecting";
let connectedAt: string | undefined;
let lastError: string | undefined;
let shuttingDown = false;
let gatewayReconnectTimer: ReturnType<typeof setTimeout> | undefined;

console.log(`[bot-worker] starting '${config.botId}'`);
console.log(`[bot-worker] gateway: ${config.gatewayUrl}`);
console.log(`[bot-worker] minecraft: ${config.mcHost}:${config.mcPort} as ${config.username}`);

connectGateway();
connectMinecraft();

const statusTimer = setInterval(() => {
  publishStatus();
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
  try {
    const result = await executeAction(message.action);
    sendToGateway({
      type: "worker.result",
      requestId: message.requestId,
      ok: true,
      result,
    });
  } catch (error) {
    sendToGateway({
      type: "worker.result",
      requestId: message.requestId,
      ok: false,
      error: asErrorMessage(error),
    });
  }
}

async function executeAction(action: Extract<GatewayToWorkerMessage, { type: "gateway.command" }>["action"]): Promise<ActionResult> {
  const activeBot = requireBot();

  if (action.name === "chat") {
    activeBot.chat(action.args.message);
    return {
      ok: true,
      message: "Message sent",
    };
  }

  if (action.name === "follow_player") {
    return followPlayer(activeBot, action.args.playerName, action.args.distance);
  }

  stopCurrentControls(activeBot, action.args?.reason);

  return {
    ok: true,
    message: "Current controls stopped",
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
