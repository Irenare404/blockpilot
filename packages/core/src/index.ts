export const BLOCKPILOT_PROTOCOL_VERSION = "0.1";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonRecord = { [key: string]: JsonValue };

export type BotConnectionState = "connecting" | "online" | "offline" | "errored";

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export interface BotStatus {
  botId: string;
  state: BotConnectionState;
  updatedAt: string;
  username?: string;
  connectedAt?: string;
  health?: number;
  food?: number;
  position?: Vec3Like;
  dimension?: string;
  gameMode?: string;
  lastError?: string;
}

export interface ChatAction {
  name: "chat";
  args: {
    message: string;
  };
}

export interface StopAction {
  name: "stop";
  args?: {
    reason?: string;
  };
}

export interface FollowPlayerAction {
  name: "follow_player";
  args: {
    playerName: string;
    distance?: number;
  };
}

export type BotAction = ChatAction | StopAction | FollowPlayerAction;

export interface ActionResult {
  ok: boolean;
  message?: string;
  data?: JsonRecord;
}

export interface BlockPilotEvent {
  id: string;
  botId: string;
  kind: string;
  createdAt: string;
  message?: string;
  payload?: JsonRecord;
}

export interface WorkerHelloMessage {
  type: "worker.hello";
  protocolVersion: string;
  botId: string;
  workerName?: string;
}

export interface WorkerStatusMessage {
  type: "worker.status";
  status: BotStatus;
}

export interface WorkerEventMessage {
  type: "worker.event";
  event: BlockPilotEvent;
}

export interface WorkerResultMessage {
  type: "worker.result";
  requestId: string;
  ok: boolean;
  result?: ActionResult;
  error?: string;
}

export type WorkerToGatewayMessage =
  | WorkerHelloMessage
  | WorkerStatusMessage
  | WorkerEventMessage
  | WorkerResultMessage;

export interface GatewayCommandMessage {
  type: "gateway.command";
  requestId: string;
  action: BotAction;
}

export interface GatewayAckMessage {
  type: "gateway.ack";
  protocolVersion: string;
  message: string;
}

export type GatewayToWorkerMessage = GatewayCommandMessage | GatewayAckMessage;

export function nowIso(): string {
  return new Date().toISOString();
}

export function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function safeJsonParse(input: string): unknown {
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return undefined;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isWorkerToGatewayMessage(value: unknown): value is WorkerToGatewayMessage {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }

  switch (value.type) {
    case "worker.hello":
      return typeof value.botId === "string" && typeof value.protocolVersion === "string";
    case "worker.status":
      return isRecord(value.status) && typeof value.status.botId === "string";
    case "worker.event":
      return isRecord(value.event) && typeof value.event.botId === "string" && typeof value.event.kind === "string";
    case "worker.result":
      return typeof value.requestId === "string" && typeof value.ok === "boolean";
    default:
      return false;
  }
}

export function isGatewayCommandMessage(value: unknown): value is GatewayCommandMessage {
  return (
    isRecord(value) &&
    value.type === "gateway.command" &&
    typeof value.requestId === "string" &&
    isBotAction(value.action)
  );
}

export function isBotAction(value: unknown): value is BotAction {
  if (!isRecord(value) || typeof value.name !== "string") {
    return false;
  }

  if (value.name === "chat") {
    return isRecord(value.args) && typeof value.args.message === "string" && value.args.message.trim().length > 0;
  }

  if (value.name === "stop") {
    return value.args === undefined || isRecord(value.args);
  }

  if (value.name === "follow_player") {
    if (!isRecord(value.args) || typeof value.args.playerName !== "string" || value.args.playerName.trim().length === 0) {
      return false;
    }

    return value.args.distance === undefined || (typeof value.args.distance === "number" && value.args.distance > 0);
  }

  return false;
}

export function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
