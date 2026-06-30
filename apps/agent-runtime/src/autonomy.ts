import type { BotCapability, WorldSnapshot } from "@blockpilot/core";
import type { GatewayClient } from "./gateway-client.js";
import type { AgentMemorySnapshot, AutonomyMode, MemoryStore } from "./memory-store.js";

export interface AutonomyConfig {
  enabled: boolean;
  mode: AutonomyMode;
  intervalMs: number;
  chatEnabled: boolean;
  allowedActionNames: string[];
}

export class AutonomyLoop {
  private readonly client: GatewayClient;
  private readonly memory: MemoryStore;
  private readonly config: AutonomyConfig;
  private lastActedAt = 0;
  private lastMessageKey: string | undefined;

  constructor(client: GatewayClient, memory: MemoryStore, config: AutonomyConfig) {
    this.client = client;
    this.memory = memory;
    this.config = config;
  }

  async handle(world: WorldSnapshot, memory: AgentMemorySnapshot): Promise<boolean> {
    if (!this.config.enabled || !this.config.chatEnabled) {
      return false;
    }

    if (!this.canSpeak(world.capabilities) || world.currentTask) {
      return false;
    }

    if (world.safety.dangerLevel === "danger" || world.safety.dangerLevel === "critical") {
      return false;
    }

    const now = Date.now();
    const persistedLastActedAt = memory.autonomy.lastActedAt ? Date.parse(memory.autonomy.lastActedAt) : 0;
    const lastActedAt = Math.max(this.lastActedAt, Number.isFinite(persistedLastActedAt) ? persistedLastActedAt : 0);
    if (now - lastActedAt < this.config.intervalMs) {
      return false;
    }

    const message = chooseAutonomyMessage(world, memory, this.config.mode);
    if (!message) {
      return false;
    }

    const key = normalizeMessage(message);
    if (key === this.lastMessageKey) {
      return false;
    }

    this.lastActedAt = now;
    this.lastMessageKey = key;
    await this.client.chat(message);
    await this.memory.markAutonomyActed(message, new Date(now).toISOString());
    return true;
  }

  private canSpeak(capabilities: BotCapability[]): boolean {
    return this.config.allowedActionNames.includes("chat") && capabilities.some((capability) => capability.name === "chat");
  }
}

function chooseAutonomyMessage(world: WorldSnapshot, memory: AgentMemorySnapshot, mode: AutonomyMode): string | undefined {
  if (mode === "guard") {
    return chooseGuardMessage(world, memory);
  }

  if (mode === "explore" || mode === "free_roam") {
    return chooseExploreMessage(world, memory);
  }

  if (mode === "builder") {
    return chooseBuilderMessage(world, memory);
  }

  return chooseCompanionMessage(world, memory);
}

function chooseCompanionMessage(world: WorldSnapshot, memory: AgentMemorySnapshot): string | undefined {
  const spawner = world.blocks.nearbySpawners[0] ?? memory.places.find((place) => place.kind === "spawner");
  if (spawner) {
    return "\u6211\u770B\u5230\u9644\u8FD1\u50CF\u662F\u5237\u602A\u88C5\u7F6E\uFF0C\u6211\u5148\u5F53\u6210\u751F\u7535\u8BBE\u65BD\uFF0C\u4E0D\u4E71\u6253\u602A\u3002";
  }

  const container = world.blocks.nearbyContainers[0] ?? memory.places.find((place) => place.kind === "container");
  if (container) {
    return "\u6211\u8BB0\u4F4F\u9644\u8FD1\u6709\u5BB9\u5668\u4E86\u3002\u4EE5\u540E\u4F60\u8BA9\u6211\u770B\u4ED3\u5E93\uFF0C\u6211\u4F1A\u628A\u8FD9\u91CC\u5F53\u7EBF\u7D22\u3002";
  }

  if (memory.home) {
    return `\u6211\u8BB0\u5F97\u5BB6\u5728 ${formatPosition(memory.home.position)}\uFF0C\u7A7A\u4E86\u53EF\u4EE5\u4ECE\u8FD9\u91CC\u51FA\u53D1\u63A2\u7D22\u3002`;
  }

  const player = world.nearbyPlayers[0];
  if (player) {
    return `\u6211\u5728\u65C1\u8FB9\u770B\u7740\uFF0C\u770B\u5230 ${player.username} \u5728\u9644\u8FD1\u3002`;
  }

  return "\u6211\u5728\u89C2\u5BDF\u5468\u56F4\uFF0C\u6682\u65F6\u5B89\u5168\u3002";
}

function chooseGuardMessage(world: WorldSnapshot, memory: AgentMemorySnapshot): string | undefined {
  const nearestThreat = world.safety.threats.find((threat) => !threat.trapped);
  if (nearestThreat) {
    return `\u6211\u770B\u5230 ${nearestThreat.name}\uFF0C\u4F1A\u4FDD\u6301\u8DDD\u79BB\uFF0C\u5148\u4FDD\u62A4\u81EA\u5DF1\u548C\u9644\u8FD1\u73A9\u5BB6\u3002`;
  }

  const player = world.nearbyPlayers[0] ?? memory.players[0];
  if (player) {
    return `\u6211\u4F1A\u5148\u7559\u610F ${player.username} \u9644\u8FD1\u7684\u60C5\u51B5\uFF0C\u6709\u5371\u9669\u5C31\u5148\u8EB2\u5F00\u3002`;
  }

  return "\u6211\u5148\u5728\u9644\u8FD1\u5B88\u7740\uFF0C\u6CA1\u770B\u5230\u7D27\u6025\u5A01\u80C1\u3002";
}

function chooseExploreMessage(world: WorldSnapshot, memory: AgentMemorySnapshot): string | undefined {
  const place = memory.places.find((item) => item.kind === "visited") ?? memory.home;
  if (place) {
    return `\u6211\u60F3\u4ECE ${formatPosition(place.position)} \u9644\u8FD1\u7EE7\u7EED\u63A2\u4E00\u5708\uFF0C\u770B\u770B\u6709\u6CA1\u6709\u65B0\u5730\u5F62\u6216\u8D44\u6E90\u3002`;
  }

  if (world.status.position) {
    return `\u6211\u60F3\u8BB0\u4E00\u4E0B\u8FD9\u7247\u5730\u65B9 ${formatPosition(world.status.position)}\uFF0C\u7B49\u4F60\u7A7A\u4E86\u6211\u4EEC\u53EF\u4EE5\u5F80\u5468\u56F4\u63A2\u7D22\u3002`;
  }

  return undefined;
}

function chooseBuilderMessage(world: WorldSnapshot, memory: AgentMemorySnapshot): string | undefined {
  const utility = world.blocks.nearbyUtilityBlocks[0] ?? memory.places.find((place) => place.kind === "utility");
  if (utility) {
    return "\u8FD9\u9644\u8FD1\u6709\u5DE5\u4F5C\u65B9\u5757\uFF0C\u6211\u53EF\u4EE5\u628A\u8FD9\u91CC\u5F53\u6210\u5EFA\u9020\u6216\u6574\u7406\u7269\u8D44\u7684\u70B9\u3002";
  }

  if (memory.home) {
    return "\u6211\u5728\u60F3\u53EF\u4EE5\u7ED9\u5BB6\u9644\u8FD1\u505A\u4E2A\u5C0F\u6807\u8BB0\u6216\u5C0F\u5C4B\uFF0C\u8FD9\u6837\u56DE\u6765\u66F4\u597D\u8BA4\u3002";
  }

  return "\u6211\u5148\u89C2\u5BDF\u54EA\u91CC\u9002\u5408\u5F53\u5C0F\u636E\u70B9\u3002";
}

function formatPosition(position: { x: number; y: number; z: number }): string {
  return `${position.x}, ${position.y}, ${position.z}`;
}

function normalizeMessage(message: string): string {
  return message.trim().toLowerCase().replace(/\s+/gu, " ");
}
