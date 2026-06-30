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

export interface BotAction {
  name: string;
  args?: JsonRecord;
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

export type BuiltInBotAction = ChatAction | StopAction | FollowPlayerAction;

export interface BotCapabilityParameterSchema {
  type: "string" | "number" | "boolean";
  description?: string;
  default?: JsonValue;
  enum?: JsonValue[];
  minimum?: number;
  maximum?: number;
}

export interface BotCapabilityParametersSchema {
  type: "object";
  properties: Record<string, BotCapabilityParameterSchema>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface BotCapability {
  name: string;
  description: string;
  source: "builtin" | "plugin";
  parameters: BotCapabilityParametersSchema;
}

export interface NearbyPlayerSnapshot {
  username: string;
  position?: Vec3Like;
  distance?: number;
}

export interface ChatMessageSnapshot {
  username: string;
  message: string;
  receivedAt: string;
}

export interface WorldSnapshot {
  botId: string;
  updatedAt: string;
  status: BotStatus;
  capabilities: BotCapability[];
  nearbyPlayers: NearbyPlayerSnapshot[];
  recentChat: ChatMessageSnapshot[];
}

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
  capabilities?: BotCapability[];
}

export interface WorkerStatusMessage {
  type: "worker.status";
  status: BotStatus;
}

export interface WorkerWorldMessage {
  type: "worker.world";
  snapshot: WorldSnapshot;
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
  | WorkerWorldMessage
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
    case "worker.world":
      return isRecord(value.snapshot) && typeof value.snapshot.botId === "string";
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

  return value.name.trim().length > 0 && (value.args === undefined || isRecord(value.args));
}

export function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
