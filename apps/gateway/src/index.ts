import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { loadDotEnv } from "@blockpilot/node-env";
import {
  asErrorMessage,
  BLOCKPILOT_PROTOCOL_VERSION,
  createId,
  isBotAction,
  isRecord,
  isWorkerToGatewayMessage,
  nowIso,
  safeJsonParse,
  type BotAction,
  type BotCapability,
  type BotStatus,
  type BotTaskSnapshot,
  type GatewayCommandMessage,
  type WorldSnapshot,
  type WorkerResultMessage,
} from "@blockpilot/core";
import { WebSocket, WebSocketServer, type RawData } from "ws";

loadDotEnv();

interface PendingCommand {
  resolve: (message: WorkerResultMessage) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface WorkerSession {
  botId: string;
  socket: WebSocket;
  status: BotStatus;
  capabilities: BotCapability[];
  world?: WorldSnapshot;
  currentTask?: BotTaskSnapshot;
  tasks: Map<string, BotTaskSnapshot>;
  pending: Map<string, PendingCommand>;
}

const host = process.env.BLOCKPILOT_GATEWAY_HOST ?? "127.0.0.1";
const port = readInteger(process.env.BLOCKPILOT_GATEWAY_PORT, 8787);
const commandTimeoutMs = readInteger(process.env.BLOCKPILOT_COMMAND_TIMEOUT_MS, 15_000);

const workerSessions = new Map<string, WorkerSession>();
const socketSessions = new WeakMap<WebSocket, WorkerSession>();
const eventClients = new Set<WebSocket>();

const server = createServer((request, response) => {
  void handleHttpRequest(request, response);
});

const workerServer = new WebSocketServer({ noServer: true });
const eventServer = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  if (url.pathname === "/worker") {
    workerServer.handleUpgrade(request, socket, head, (webSocket) => {
      workerServer.emit("connection", webSocket, request);
    });
    return;
  }

  if (url.pathname === "/events") {
    eventServer.handleUpgrade(request, socket, head, (webSocket) => {
      eventServer.emit("connection", webSocket, request);
    });
    return;
  }

  socket.destroy();
});

workerServer.on("connection", (socket) => {
  console.log("[gateway] worker socket connected");

  socket.on("message", (data) => {
    handleWorkerMessage(socket, data);
  });

  socket.on("close", () => {
    const session = socketSessions.get(socket);
    if (!session) {
      console.log("[gateway] unregistered worker socket closed");
      return;
    }

    rejectPending(session, new Error("Worker disconnected"));

    if (workerSessions.get(session.botId)?.socket === socket) {
      session.status = {
        ...session.status,
        state: "offline",
        updatedAt: nowIso(),
      };
      broadcastStatus(session.status);
    }

    console.log(`[gateway] worker '${session.botId}' disconnected`);
  });

  socket.on("error", (error) => {
    console.warn(`[gateway] worker socket error: ${error.message}`);
  });
});

eventServer.on("connection", (socket) => {
  eventClients.add(socket);

  socket.send(
    JSON.stringify({
      type: "gateway.snapshot",
      protocolVersion: BLOCKPILOT_PROTOCOL_VERSION,
      bots: [...workerSessions.values()].map((session) => session.status),
      worlds: [...workerSessions.values()].map((session) => session.world ?? createFallbackWorldSnapshot(session)),
    }),
  );

  socket.on("close", () => {
    eventClients.delete(socket);
  });
});

server.listen(port, host, () => {
  console.log(`[gateway] listening on http://${host}:${port}`);
  console.log(`[gateway] worker websocket: ws://${host}:${port}/worker`);
  console.log(`[gateway] events websocket: ws://${host}:${port}/events`);
});

async function handleHttpRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  if (request.method === "OPTIONS") {
    sendJson(response, 204, {});
    return;
  }

  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, {
      ok: true,
      service: "blockpilot-gateway",
      protocolVersion: BLOCKPILOT_PROTOCOL_VERSION,
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/bots") {
    sendJson(response, 200, {
      bots: [...workerSessions.values()].map((session) => session.status),
    });
    return;
  }

  const statusMatch = /^\/bots\/([^/]+)\/status$/.exec(url.pathname);
  if (request.method === "GET" && statusMatch?.[1]) {
    const botId = decodeURIComponent(statusMatch[1]);
    const session = workerSessions.get(botId);

    if (!session) {
      sendJson(response, 404, { error: `Unknown bot '${botId}'` });
      return;
    }

    sendJson(response, 200, session.status);
    return;
  }

  const actionMatch = /^\/bots\/([^/]+)\/actions$/.exec(url.pathname);
  if (request.method === "GET" && actionMatch?.[1]) {
    const botId = decodeURIComponent(actionMatch[1]);
    const session = workerSessions.get(botId);

    if (!session) {
      sendJson(response, 404, { error: `Unknown bot '${botId}'` });
      return;
    }

    sendJson(response, 200, {
      botId,
      actions: session.capabilities,
    });
    return;
  }

  const tasksMatch = /^\/bots\/([^/]+)\/tasks$/.exec(url.pathname);
  if (request.method === "GET" && tasksMatch?.[1]) {
    const botId = decodeURIComponent(tasksMatch[1]);
    const session = workerSessions.get(botId);

    if (!session) {
      sendJson(response, 404, { error: `Unknown bot '${botId}'` });
      return;
    }

    sendJson(response, 200, {
      botId,
      currentTask: session.currentTask,
      recentTasks: getRecentTasks(session),
    });
    return;
  }

  const worldMatch = /^\/bots\/([^/]+)\/world$/.exec(url.pathname);
  if (request.method === "GET" && worldMatch?.[1]) {
    const botId = decodeURIComponent(worldMatch[1]);
    const session = workerSessions.get(botId);

    if (!session) {
      sendJson(response, 404, { error: `Unknown bot '${botId}'` });
      return;
    }

    sendJson(response, 200, session.world ?? createFallbackWorldSnapshot(session));
    return;
  }

  if (request.method === "POST" && actionMatch?.[1]) {
    const botId = decodeURIComponent(actionMatch[1]);
    const body = await readJsonBody(request);
    const action = parseActionBody(body);

    if (!action) {
      sendJson(response, 400, {
        error:
          "Invalid action. Use {\"name\":\"chat\",\"args\":{\"message\":\"hello\"}}, {\"name\":\"follow_player\",\"args\":{\"playerName\":\"Steve\"}}, {\"name\":\"dig_nearest_block\",\"args\":{\"blockName\":\"dirt\"}}, {\"name\":\"inspect_nearest_container\",\"args\":{}}, or {\"name\":\"stop\"}.",
      });
      return;
    }

    try {
      const result = await dispatchAction(botId, action);
      sendJson(response, result.ok ? 200 : 502, result);
    } catch (error) {
      sendJson(response, 409, { error: asErrorMessage(error) });
    }
    return;
  }

  sendJson(response, 404, { error: "Not found" });
}

function handleWorkerMessage(socket: WebSocket, data: RawData): void {
  const parsed = safeJsonParse(data.toString());

  if (!isWorkerToGatewayMessage(parsed)) {
    console.warn("[gateway] ignored invalid worker message");
    return;
  }

  if (parsed.type === "worker.hello") {
    const existing = workerSessions.get(parsed.botId);
    if (existing && existing.socket !== socket) {
      rejectPending(existing, new Error("Worker replaced by a new connection"));
      if (existing.socket.readyState === WebSocket.OPEN) {
        existing.socket.close(4000, "replaced");
      }
    }

    const session: WorkerSession = {
      botId: parsed.botId,
      socket,
      pending: new Map(),
      capabilities: parsed.capabilities ?? [],
      tasks: new Map(),
      status: {
        botId: parsed.botId,
        state: "online",
        connectedAt: nowIso(),
        updatedAt: nowIso(),
      },
    };

    workerSessions.set(parsed.botId, session);
    socketSessions.set(socket, session);

    socket.send(
      JSON.stringify({
        type: "gateway.ack",
        protocolVersion: BLOCKPILOT_PROTOCOL_VERSION,
        message: `Registered worker '${parsed.botId}'`,
      }),
    );

    broadcastStatus(session.status);
    console.log(`[gateway] worker '${parsed.botId}' registered`);
    return;
  }

  const session = socketSessions.get(socket);
  if (!session) {
    console.warn("[gateway] ignored message from unregistered worker");
    return;
  }

  if (parsed.type === "worker.status") {
    session.status = parsed.status;
    workerSessions.set(session.botId, session);
    broadcastStatus(session.status);
    return;
  }

  if (parsed.type === "worker.world") {
    session.world = parsed.snapshot;
    syncTasksFromWorld(session, parsed.snapshot);
    workerSessions.set(session.botId, session);
    broadcast({
      type: "gateway.world",
      snapshot: parsed.snapshot,
    });
    return;
  }

  if (parsed.type === "worker.task") {
    rememberTask(session, parsed.task);
    workerSessions.set(session.botId, session);
    broadcast({
      type: "gateway.task",
      task: parsed.task,
    });
    return;
  }

  if (parsed.type === "worker.event") {
    broadcast({
      type: "gateway.event",
      event: parsed.event,
    });
    console.log(`[gateway] event ${parsed.event.kind}: ${parsed.event.message ?? ""}`);
    return;
  }

  const pending = session.pending.get(parsed.requestId);
  if (!pending) {
    console.warn(`[gateway] result for unknown request '${parsed.requestId}'`);
    return;
  }

  clearTimeout(pending.timeout);
  session.pending.delete(parsed.requestId);
  pending.resolve(parsed);
}

function createFallbackWorldSnapshot(session: WorkerSession): WorldSnapshot {
  const self: WorldSnapshot["self"] = {
    inventory: [],
    equipment: [],
  };

  if (typeof session.status.health === "number") {
    self.health = session.status.health;
  }

  if (typeof session.status.food === "number") {
    self.food = session.status.food;
  }

  const snapshot: WorldSnapshot = {
    botId: session.botId,
    updatedAt: nowIso(),
    status: session.status,
    capabilities: session.capabilities,
    recentTasks: getRecentTasks(session),
    nearbyPlayers: [],
    recentChat: [],
    entities: {
      mobs: [],
      animals: [],
      items: [],
      others: [],
    },
    blocks: {
      nearbyUtilityBlocks: [],
      nearbyDangerBlocks: [],
      nearbyContainers: [],
      nearbySpawners: [],
    },
    self,
    safety: {
      dangerLevel: "safe",
      threats: [],
      reasons: [],
    },
  };

  if (session.currentTask) {
    snapshot.currentTask = session.currentTask;
  }

  return snapshot;
}

function rememberTask(session: WorkerSession, task: BotTaskSnapshot): void {
  session.tasks.set(task.taskId, task);

  if (task.state === "running") {
    session.currentTask = task;
    return;
  }

  if (session.currentTask?.taskId === task.taskId) {
    delete session.currentTask;
  }
}

function syncTasksFromWorld(session: WorkerSession, snapshot: WorldSnapshot): void {
  for (const task of snapshot.recentTasks) {
    session.tasks.set(task.taskId, task);
  }

  if (snapshot.currentTask) {
    session.currentTask = snapshot.currentTask;
  } else {
    delete session.currentTask;
  }
}

function getRecentTasks(session: WorkerSession): BotTaskSnapshot[] {
  return [...session.tasks.values()]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 20);
}

function dispatchAction(botId: string, action: BotAction): Promise<WorkerResultMessage> {
  const session = workerSessions.get(botId);
  if (!session) {
    return Promise.reject(new Error(`Unknown bot '${botId}'`));
  }

  if (session.socket.readyState !== WebSocket.OPEN || session.status.state !== "online") {
    return Promise.reject(new Error(`Bot '${botId}' is not online`));
  }

  const requestId = createId("cmd");
  const command: GatewayCommandMessage = {
    type: "gateway.command",
    requestId,
    action,
  };

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      session.pending.delete(requestId);
      reject(new Error(`Command '${action.name}' timed out after ${commandTimeoutMs}ms`));
    }, commandTimeoutMs);

    session.pending.set(requestId, { resolve, reject, timeout });

    session.socket.send(JSON.stringify(command), (error) => {
      if (error) {
        clearTimeout(timeout);
        session.pending.delete(requestId);
        reject(error);
      }
    });
  });
}

function parseActionBody(body: unknown): BotAction | undefined {
  if (isBotAction(body)) {
    return body;
  }

  if (!isRecord(body)) {
    return undefined;
  }

  const name = typeof body.action === "string" ? body.action : body.name;

  if (name === "chat" && typeof body.message === "string" && body.message.trim().length > 0) {
    return {
      name: "chat",
      args: {
        message: body.message,
      },
    };
  }

  if (name === "stop") {
    if (typeof body.reason === "string") {
      return {
        name: "stop",
        args: {
          reason: body.reason,
        },
      };
    }

    return {
      name: "stop",
    };
  }

  if (
    name === "follow_player" &&
    typeof body.playerName === "string" &&
    body.playerName.trim().length > 0
  ) {
    const distance = typeof body.distance === "number" && body.distance > 0 ? body.distance : undefined;
    const args: BotAction["args"] = {
      playerName: body.playerName,
    };

    if (distance !== undefined) {
      args.distance = distance;
    }

    return {
      name: "follow_player",
      args,
    };
  }

  return undefined;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(buffer);

    if (Buffer.concat(chunks).length > 1_000_000) {
      throw new Error("Request body too large");
    }
  }

  if (chunks.length === 0) {
    return {};
  }

  return safeJsonParse(Buffer.concat(chunks).toString("utf8"));
}

function rejectPending(session: WorkerSession, error: Error): void {
  for (const [requestId, pending] of session.pending) {
    clearTimeout(pending.timeout);
    pending.reject(error);
    session.pending.delete(requestId);
  }
}

function broadcastStatus(status: BotStatus): void {
  broadcast({
    type: "gateway.status",
    status,
  });
}

function broadcast(message: unknown): void {
  const payload = JSON.stringify(message);

  for (const client of eventClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  const payload = statusCode === 204 ? "" : JSON.stringify(body, null, 2);

  response.writeHead(statusCode, {
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-origin": "*",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(payload);
}

function readInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
