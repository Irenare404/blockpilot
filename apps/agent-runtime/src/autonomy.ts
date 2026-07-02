import type { BotCapability, WorldSnapshot } from "@blockpilot/core";
import type { GatewayClient } from "./gateway-client.js";
import type { AgentMemorySnapshot, AutonomyMode, MemoryStore } from "./memory-store.js";

export interface AutonomyConfig {
  enabled: boolean;
  mode: AutonomyMode;
  intervalMs: number;
  chatEnabled: boolean;
  requireRecentChat: boolean;
  recentChatWindowMs: number;
  startupGraceMs: number;
  allowedActionNames: string[];
}

export class AutonomyLoop {
  private readonly client: GatewayClient;
  private readonly memory: MemoryStore;
  private readonly config: AutonomyConfig;
  private readonly startedAt = Date.now();
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

    const now = Date.now();
    if (now - this.startedAt < this.config.startupGraceMs) {
      return false;
    }

    if (this.config.requireRecentChat && !hasRecentPlayerChat(world, this.config.recentChatWindowMs)) {
      return false;
    }

    if (world.safety.dangerLevel === "danger" || world.safety.dangerLevel === "critical") {
      return false;
    }

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
  const player = world.nearbyPlayers[0];
  if (player) {
    return `${player.username}\uFF0C\u9700\u8981\u6211\u8DDF\u968F\u3001\u67E5\u770B\u7BB1\u5B50\u6216\u6316\u9644\u8FD1\u65B9\u5757\u65F6\u53EB\u6211\u3002`;
  }

  return undefined;
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

function hasRecentPlayerChat(world: WorldSnapshot, windowMs: number): boolean {
  const now = Date.now();
  const botUsername = world.status.username ?? world.botId;
  return world.recentChat.some((message) => {
    if (message.username.localeCompare(botUsername, undefined, { sensitivity: "accent" }) === 0) {
      return false;
    }

    const receivedAt = Date.parse(message.receivedAt);
    return Number.isFinite(receivedAt) && now - receivedAt <= windowMs;
  });
}
