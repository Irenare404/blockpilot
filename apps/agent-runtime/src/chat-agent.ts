import { asErrorMessage, createId, type BotCapability, type ChatMessageSnapshot, type WorldSnapshot } from "@blockpilot/core";
import type { AgentDecisionLogger } from "./decision-log.js";
import type { GatewayClient } from "./gateway-client.js";
import type { AgentMemorySnapshot, MemoryStore } from "./memory-store.js";
import type { AgentPlan, AgentPlanStep, AgentPlanner, PlannerContext } from "./planner.js";

export interface SafetyHandler {
  handle(world: WorldSnapshot): Promise<boolean>;
}

export interface AutonomyHandler {
  handle(world: WorldSnapshot, memory: AgentMemorySnapshot): Promise<boolean>;
}

export interface ChatAgentConfig {
  botId: string;
  commandPrefix: string;
  aliases: string[];
  allowedActionNames: string[];
  responseDedupMs: number;
  memory?: MemoryStore;
  safety?: SafetyHandler;
  autonomy?: AutonomyHandler;
  decisionLogger?: AgentDecisionLogger;
}

export class ChatAgent {
  private readonly client: GatewayClient;
  private readonly planner: AgentPlanner;
  private readonly config: ChatAgentConfig;
  private readonly handledChatKeys: string[] = [];
  private readonly handledChatSet = new Set<string>();
  private readonly recentReplies: Array<{ key: string; sentAt: number }> = [];

  constructor(client: GatewayClient, planner: AgentPlanner, config: ChatAgentConfig) {
    this.client = client;
    this.planner = planner;
    this.config = config;
  }

  async tick(): Promise<void> {
    const tickId = createId("tick");
    const world = await this.client.getWorld();
    const botUsername = world.status.username ?? this.config.botId;
    const botNames = createBotNames(this.config.botId, botUsername, this.config.aliases);
    const memory = this.config.memory;

    await memory?.observeWorld(world);
    const memorySnapshot = memory?.getSnapshot();
    this.log("tick.start", {
      tickId,
      botId: this.config.botId,
      botUsername,
      world: compactWorld(world),
      memory: memorySnapshot ? compactMemory(memorySnapshot) : undefined,
      allowedActionNames: this.config.allowedActionNames,
      capabilityNames: world.capabilities.map((capability) => capability.name),
    });

    const safetyActed = (await this.config.safety?.handle(world)) ?? false;
    this.log("safety.result", {
      tickId,
      acted: safetyActed,
      dangerLevel: world.safety.dangerLevel,
      threats: world.safety.threats.slice(0, 8),
      reasons: world.safety.reasons.slice(0, 8),
    });
    if (safetyActed) {
      this.log("tick.end", { tickId, outcome: "safety_action" });
      return;
    }

    const nextChat = this.takeLatestUnhandledChat(world.recentChat, botNames);
    this.log("chat.selection", {
      tickId,
      selected: nextChat ? compactChat(nextChat) : undefined,
      recentVisibleChatCount: world.recentChat.filter((message) => !isOwnChat(message.username, botNames)).length,
      handledChatCount: this.handledChatSet.size,
    });
    if (!nextChat) {
      let autonomyActed = false;
      if (memorySnapshot) {
        autonomyActed = (await this.config.autonomy?.handle(world, memorySnapshot)) ?? false;
      }
      this.log("autonomy.result", { tickId, acted: autonomyActed });
      this.log("tick.end", { tickId, outcome: autonomyActed ? "autonomy_action" : "idle" });
      return;
    }

    const context: PlannerContext = {
      botId: this.config.botId,
      botUsername,
      botNames,
      commandPrefix: this.config.commandPrefix,
      allowedActionNames: this.config.allowedActionNames,
      chat: nextChat,
      world,
    };
    if (memorySnapshot) {
      context.memory = memorySnapshot;
    }

    const plan = await this.planner.plan(context);
    this.log("planner.result", {
      tickId,
      chat: compactChat(nextChat),
      addressedToBot: plan.addressedToBot,
      confidence: plan.confidence,
      reason: plan.reason,
      steps: plan.steps.map(compactStep),
    });

    if (!plan.addressedToBot) {
      this.log("tick.end", { tickId, outcome: "ignored_not_addressed", reason: plan.reason });
      return;
    }

    await this.executePlan(plan, world, tickId);
    this.log("tick.end", { tickId, outcome: "plan_executed" });
  }

  private async executePlan(plan: AgentPlan, world: WorldSnapshot, tickId: string): Promise<void> {
    for (const step of plan.steps) {
      if (step.type === "say") {
        if (!this.canRunAction(world.capabilities, "chat")) {
          console.warn("[agent-runtime] skipped unavailable action 'chat'");
          this.log("step.skipped", { tickId, step: compactStep(step), reason: "chat_unavailable_or_not_allowed" });
          continue;
        }

        if (this.isDuplicateReply(step.message)) {
          console.warn("[agent-runtime] skipped duplicate chat reply");
          this.log("step.skipped", { tickId, step: compactStep(step), reason: "duplicate_reply" });
          continue;
        }

        this.rememberReply(step.message);
        this.log("step.execute", { tickId, step: compactStep(step) });
        try {
          const result = await this.client.chat(step.message);
          this.log("step.result", { tickId, step: compactStep(step), result });
        } catch (error) {
          this.log("step.error", { tickId, step: compactStep(step), error: asErrorMessage(error) });
          throw error;
        }
        continue;
      }

      if (step.type === "memory") {
        if (step.operation === "set_home") {
          this.log("step.execute", { tickId, step: compactStep(step) });
          const saved = await this.config.memory?.setHomeFromWorld(world, step.notes);
          this.log("step.result", { tickId, step: compactStep(step), result: { saved: saved === true } });
          if (!saved) {
            console.warn("[agent-runtime] skipped set_home because position or memory was unavailable");
            this.log("step.skipped", { tickId, step: compactStep(step), reason: "position_or_memory_unavailable" });
          }
        }
        continue;
      }

      if (!this.canRunAction(world.capabilities, step.action.name)) {
        console.warn(`[agent-runtime] skipped unavailable action '${step.action.name}'`);
        this.log("step.skipped", { tickId, step: compactStep(step), reason: "action_unavailable_or_not_allowed" });
        continue;
      }

      this.log("step.execute", { tickId, step: compactStep(step) });
      try {
        const result = await this.client.runAction(step.action);
        this.log("step.result", { tickId, step: compactStep(step), result });
      } catch (error) {
        this.log("step.error", { tickId, step: compactStep(step), error: asErrorMessage(error) });
        throw error;
      }
    }
  }

  private takeLatestUnhandledChat(chat: ChatMessageSnapshot[], botNames: string[]): ChatMessageSnapshot | undefined {
    const candidates = sortChat(chat).filter((message) => !isOwnChat(message.username, botNames));
    const unhandled = candidates.filter((message) => !this.handledChatSet.has(createChatKey(message)));

    if (unhandled.length === 0) {
      return undefined;
    }

    for (const stale of unhandled.slice(0, -1)) {
      this.rememberHandledChat(createChatKey(stale));
    }

    const latest = unhandled[unhandled.length - 1];
    if (!latest) {
      return undefined;
    }

    this.rememberHandledChat(createChatKey(latest));
    return latest;
  }

  private canRunAction(capabilities: BotCapability[], actionName: string): boolean {
    return this.config.allowedActionNames.includes(actionName) && capabilities.some((capability) => capability.name === actionName);
  }

  private isDuplicateReply(message: string): boolean {
    const key = normalizeReply(message);
    const now = Date.now();
    this.pruneRecentReplies(now);
    return this.recentReplies.some((reply) => reply.key === key);
  }

  private rememberReply(message: string): void {
    const now = Date.now();
    this.pruneRecentReplies(now);
    this.recentReplies.push({
      key: normalizeReply(message),
      sentAt: now,
    });
  }

  private pruneRecentReplies(now: number): void {
    while (this.recentReplies.length > 0) {
      const oldest = this.recentReplies[0];
      if (!oldest || now - oldest.sentAt <= this.config.responseDedupMs) {
        break;
      }

      this.recentReplies.shift();
    }
  }

  private rememberHandledChat(key: string): void {
    this.handledChatSet.add(key);
    this.handledChatKeys.push(key);

    while (this.handledChatKeys.length > 200) {
      const removed = this.handledChatKeys.shift();
      if (removed) {
        this.handledChatSet.delete(removed);
      }
    }
  }

  private log(type: string, payload?: Record<string, unknown>): void {
    this.config.decisionLogger?.log(type, payload);
  }
}

function createBotNames(botId: string, botUsername: string, aliases: string[]): string[] {
  const names = [botId, botUsername, ...aliases].map((name) => name.trim()).filter(Boolean);
  return [...new Set(names)];
}

function createChatKey(chat: ChatMessageSnapshot): string {
  return `${chat.receivedAt}:${chat.username}:${chat.message}`;
}

function normalizeReply(message: string): string {
  return message.trim().toLowerCase().replace(/\s+/gu, " ");
}

function isOwnChat(username: string, botNames: string[]): boolean {
  return botNames.some((name) => username.localeCompare(name, undefined, { sensitivity: "accent" }) === 0);
}

function sortChat(chat: ChatMessageSnapshot[]): ChatMessageSnapshot[] {
  return [...chat].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
}

function compactWorld(world: WorldSnapshot): Record<string, unknown> {
  return {
    updatedAt: world.updatedAt,
    status: {
      state: world.status.state,
      health: world.status.health,
      food: world.status.food,
      position: world.status.position,
      dimension: world.status.dimension,
      gameMode: world.status.gameMode,
    },
    currentTask: world.currentTask
      ? {
          actionName: world.currentTask.actionName,
          state: world.currentTask.state,
          args: world.currentTask.args,
        }
      : undefined,
    nearbyPlayers: world.nearbyPlayers.slice(0, 8),
    entities: {
      mobs: world.entities.mobs.slice(0, 8),
      animals: world.entities.animals.slice(0, 4),
      items: world.entities.items.slice(0, 4),
      others: world.entities.others.slice(0, 4),
    },
    blocks: {
      nearbyUtilityBlocks: world.blocks.nearbyUtilityBlocks.slice(0, 8),
      nearbyDangerBlocks: world.blocks.nearbyDangerBlocks.slice(0, 8),
      nearbyContainers: world.blocks.nearbyContainers.slice(0, 8),
      nearbySpawners: world.blocks.nearbySpawners.slice(0, 4),
    },
    self: {
      health: world.self.health,
      food: world.self.food,
      oxygenLevel: world.self.oxygenLevel,
      heldItem: world.self.heldItem,
      equipment: world.self.equipment,
      inventory: world.self.inventory.slice(0, 12),
    },
    safety: world.safety,
  };
}

function compactMemory(memory: AgentMemorySnapshot): Record<string, unknown> {
  return {
    home: memory.home,
    places: memory.places.slice(0, 8),
    players: memory.players.slice(0, 8),
    recentObservations: memory.recentObservations.slice(-8),
    autonomy: memory.autonomy,
  };
}

function compactChat(chat: ChatMessageSnapshot): Record<string, unknown> {
  return {
    username: chat.username,
    message: chat.message,
    receivedAt: chat.receivedAt,
  };
}

function compactStep(step: AgentPlanStep): Record<string, unknown> {
  if (step.type === "say") {
    return {
      type: "say",
      message: step.message,
    };
  }

  if (step.type === "memory") {
    return {
      type: "memory",
      operation: step.operation,
      notes: step.notes,
    };
  }

  return {
    type: "action",
    action: step.action,
  };
}
