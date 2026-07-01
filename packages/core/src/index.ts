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

export interface GoToPositionAction {
  name: "go_to_position";
  args: {
    x: number;
    y: number;
    z: number;
    range?: number;
  };
}

export interface DigNearestBlockAction {
  name: "dig_nearest_block";
  args: {
    blockName: string;
    maxDistance?: number;
    count?: number;
    settleMs?: number;
    waitForDropMs?: number;
    x?: number;
    y?: number;
    z?: number;
  };
}

export interface PlaceBlockAction {
  name: "place_block";
  args: {
    itemName: string;
    x: number;
    y: number;
    z: number;
  };
}

export interface UseNearestBlockAction {
  name: "use_nearest_block";
  args: {
    blockName: string;
    maxDistance?: number;
    x?: number;
    y?: number;
    z?: number;
  };
}

export interface InspectNearestContainerAction {
  name: "inspect_nearest_container";
  args?: {
    maxDistance?: number;
    x?: number;
    y?: number;
    z?: number;
  };
}

export interface CollectNearestItemAction {
  name: "collect_nearest_item";
  args?: {
    entityId?: number;
    itemName?: string;
    maxDistance?: number;
    timeoutMs?: number;
    x?: number;
    y?: number;
    z?: number;
  };
}

export interface DropItemAction {
  name: "drop_item";
  args?: {
    itemName?: string;
    count?: number;
    slot?: number;
  };
}

export interface AttackNearestEntityAction {
  name: "attack_nearest_entity";
  args?: {
    entityId?: number;
    targetName?: string;
    maxDistance?: number;
    allowPlayers?: boolean;
    allowTrapped?: boolean;
    follow?: boolean;
    x?: number;
    y?: number;
    z?: number;
  };
}

export type BuiltInBotAction =
  | ChatAction
  | StopAction
  | FollowPlayerAction
  | GoToPositionAction
  | DigNearestBlockAction
  | PlaceBlockAction
  | UseNearestBlockAction
  | InspectNearestContainerAction
  | CollectNearestItemAction
  | DropItemAction
  | AttackNearestEntityAction;

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
  velocity?: Vec3Like;
  distance?: number;
}

export interface ChatMessageSnapshot {
  username: string;
  message: string;
  receivedAt: string;
}

export type WorldEntityKind = "hostile" | "passive" | "item" | "other";

export interface WorldEntitySnapshot {
  id: number;
  name: string;
  displayName?: string;
  kind: WorldEntityKind;
  position?: Vec3Like;
  velocity?: Vec3Like;
  distance?: number;
  username?: string;
}

export interface WorldEntitiesSnapshot {
  mobs: WorldEntitySnapshot[];
  animals: WorldEntitySnapshot[];
  items: WorldEntitySnapshot[];
  others: WorldEntitySnapshot[];
}

export type WorldBlockKind = "container" | "danger" | "diggable" | "spawner" | "utility";

export interface WorldBlockSnapshot {
  name: string;
  displayName?: string;
  kind: WorldBlockKind;
  position: Vec3Like;
  distance?: number;
}

export interface WorldBlocksSnapshot {
  nearbyDiggableBlocks: WorldBlockSnapshot[];
  nearbyUtilityBlocks: WorldBlockSnapshot[];
  nearbyDangerBlocks: WorldBlockSnapshot[];
  nearbyContainers: WorldBlockSnapshot[];
  nearbySpawners: WorldBlockSnapshot[];
}

export interface InventoryItemSnapshot {
  name: string;
  displayName?: string;
  count: number;
  slot?: number;
  durabilityUsed?: number;
  maxDurability?: number;
}

export interface EquipmentItemSnapshot extends InventoryItemSnapshot {
  slotName: "head" | "torso" | "legs" | "feet" | "hand" | "off-hand";
}

export interface SelfSnapshot {
  health?: number;
  food?: number;
  oxygenLevel?: number;
  heldItem?: InventoryItemSnapshot;
  inventory: InventoryItemSnapshot[];
  equipment: EquipmentItemSnapshot[];
}

export type DangerLevel = "safe" | "watch" | "danger" | "critical";

export interface SafetyThreatSnapshot {
  kind: "entity" | "block" | "status";
  name: string;
  severity: DangerLevel;
  reason: string;
  position?: Vec3Like;
  distance?: number;
  trapped?: boolean;
  containmentReason?: string;
  canReachBot?: boolean;
}

export interface SafetySnapshot {
  dangerLevel: DangerLevel;
  threats: SafetyThreatSnapshot[];
  reasons: string[];
}

export type BotTaskState = "running" | "completed" | "failed" | "cancelled";

export interface BotTaskSnapshot {
  taskId: string;
  botId: string;
  actionName: string;
  state: BotTaskState;
  startedAt: string;
  updatedAt: string;
  args?: JsonRecord;
  completedAt?: string;
  message?: string;
  error?: string;
}

export interface WorldSnapshot {
  botId: string;
  updatedAt: string;
  status: BotStatus;
  capabilities: BotCapability[];
  currentTask?: BotTaskSnapshot;
  recentTasks: BotTaskSnapshot[];
  nearbyPlayers: NearbyPlayerSnapshot[];
  recentChat: ChatMessageSnapshot[];
  entities: WorldEntitiesSnapshot;
  blocks: WorldBlocksSnapshot;
  self: SelfSnapshot;
  safety: SafetySnapshot;
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

export interface WorkerTaskMessage {
  type: "worker.task";
  task: BotTaskSnapshot;
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
  | WorkerTaskMessage
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
    case "worker.task":
      return isRecord(value.task) && typeof value.task.taskId === "string" && typeof value.task.botId === "string";
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
