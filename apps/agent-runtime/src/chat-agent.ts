import { asErrorMessage, createId, type BotCapability, type ChatMessageSnapshot, type WorldSnapshot } from "@blockpilot/core";
import type { AgentDecisionLogger } from "./decision-log.js";
import type { GatewayClient } from "./gateway-client.js";
import type { AgentMemorySnapshot, MemoryStore } from "./memory-store.js";
import type { AgentPlan, AgentPlanStep, AgentPlanner, PlannerContext } from "./planner.js";
import type { AgentTaskQueue } from "./task-queue.js";

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
  taskQueue?: AgentTaskQueue;
}

interface PendingGatherRequest {
  actionCount: number;
  blockName: string;
  expiresAt: number;
  itemNames: string[];
  label: string;
  maxDistance: number;
  username: string;
}

const GATHER_REQUEST_TTL_MS = 120_000;
const LOG_ITEM_NAMES = [
  "log",
  "oak_log",
  "spruce_log",
  "birch_log",
  "jungle_log",
  "acacia_log",
  "dark_oak_log",
  "mangrove_log",
  "cherry_log",
  "pale_oak_log",
];

export class ChatAgent {
  private readonly client: GatewayClient;
  private readonly planner: AgentPlanner;
  private readonly config: ChatAgentConfig;
  private readonly handledChatKeys: string[] = [];
  private readonly handledChatSet = new Set<string>();
  private pendingGatherRequest: PendingGatherRequest | undefined;
  private activeGatherOwner: string | undefined;
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
    if (this.activeGatherOwner && this.config.taskQueue && !this.config.taskQueue.hasRunnableTask()) {
      this.activeGatherOwner = undefined;
    }
    const memorySnapshot = memory?.getSnapshot();
    this.log("tick.start", {
      tickId,
      botId: this.config.botId,
      botUsername,
      world: compactWorld(world),
      memory: memorySnapshot ? compactMemory(memorySnapshot) : undefined,
      tasks: this.config.taskQueue?.snapshots(),
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
      const taskActed =
        (await this.config.taskQueue?.tick(world, {
          canRunAction: (actionName) => this.canRunAction(world.capabilities, actionName),
          log: (type, payload) => this.log(type, { tickId, ...payload }),
          runAction: (action) => this.client.runAction(action),
          say: (message) => this.sendChatMessage(message, world, tickId, "task"),
        })) ?? false;
      if (taskActed) {
        this.log("tick.end", { tickId, outcome: "task_action" });
        return;
      }

      let autonomyActed = false;
      if (memorySnapshot) {
        autonomyActed = (await this.config.autonomy?.handle(world, memorySnapshot)) ?? false;
      }
      this.log("autonomy.result", { tickId, acted: autonomyActed });
      this.log("tick.end", { tickId, outcome: autonomyActed ? "autonomy_action" : "idle" });
      return;
    }

    const directPlan = this.createDirectGatherPlan(nextChat, world, botNames, tickId);
    if (directPlan) {
      this.log("planner.result", {
        tickId,
        chat: compactChat(nextChat),
        addressedToBot: directPlan.addressedToBot,
        confidence: directPlan.confidence,
        reason: directPlan.reason,
        steps: directPlan.steps.map(compactStep),
      });
      await this.executePlan(directPlan, world, tickId);
      this.log("tick.end", { tickId, outcome: "direct_gather_plan" });
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
    const taskSnapshots = this.config.taskQueue?.snapshots();
    if (taskSnapshots) {
      context.tasks = taskSnapshots;
    }

    let plan: AgentPlan;
    try {
      plan = await this.planner.plan(context);
    } catch (error) {
      this.log("planner.error", {
        tickId,
        chat: compactChat(nextChat),
        error: asErrorMessage(error),
      });
      throw error;
    }

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
        try {
          this.log("step.execute", { tickId, step: compactStep(step) });
          const result = await this.sendChatMessage(step.message, world, tickId, "plan");
          this.log("step.result", { tickId, step: compactStep(step), result });
        } catch (error) {
          this.log("step.error", { tickId, step: compactStep(step), error: asErrorMessage(error) });
          console.warn(`[agent-runtime] skipped chat reply: ${asErrorMessage(error)}`);
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

      if (step.type === "task") {
        try {
          const snapshot = this.config.taskQueue?.enqueue(step.task);
          this.log("step.result", { tickId, step: compactStep(step), result: snapshot });
          if (!snapshot) {
            this.log("step.skipped", { tickId, step: compactStep(step), reason: "task_queue_unavailable" });
          }
        } catch (error) {
          this.log("step.error", { tickId, step: compactStep(step), error: asErrorMessage(error) });
          throw error;
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
        if (step.action.name === "stop") {
          const cancelled = this.config.taskQueue?.cancelActive("Cancelled by stop action") ?? 0;
          if (cancelled > 0) {
            this.log("task.cancelled", { tickId, cancelled, reason: "stop_action" });
          }
        }
        const result = await this.client.runAction(step.action);
        this.log("step.result", { tickId, step: compactStep(step), result });
      } catch (error) {
        const message = asErrorMessage(error);
        this.log("step.error", { tickId, step: compactStep(step), error: message });
        console.warn(`[agent-runtime] action '${step.action.name}' failed: ${message}`);
        await this.notifyActionFailure(step.action.name, message, world, tickId);
        break;
      }
    }
  }

  private async notifyActionFailure(actionName: string, errorMessage: string, world: WorldSnapshot, tickId: string): Promise<void> {
    try {
      await this.sendChatMessage(createActionFailureReply(actionName, errorMessage), world, tickId, "action_error");
    } catch (notifyError) {
      this.log("step.skipped", {
        tickId,
        source: "action_error",
        reason: "failure_reply_unavailable",
        error: asErrorMessage(notifyError),
      });
    }
  }

  private async sendChatMessage(message: string, world: WorldSnapshot, tickId: string, source: string): Promise<unknown> {
    if (!this.canRunAction(world.capabilities, "chat")) {
      this.log("step.skipped", { tickId, source, reason: "chat_unavailable_or_not_allowed" });
      throw new Error("chat is unavailable or not allowed");
    }

    if (this.isDuplicateReply(message)) {
      this.log("step.skipped", { tickId, source, reason: "duplicate_reply", message });
      throw new Error("duplicate chat reply");
    }

    this.rememberReply(message);
    return this.client.chat(message);
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
    if (this.config.responseDedupMs <= 0) {
      return false;
    }

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

  private createDirectGatherPlan(
    chat: ChatMessageSnapshot,
    world: WorldSnapshot,
    botNames: string[],
    tickId: string,
  ): AgentPlan | undefined {
    const stopRequested = parseStopRequest(chat.message);
    if (stopRequested && this.activeGatherOwner && samePlayer(chat.username, this.activeGatherOwner)) {
      this.pendingGatherRequest = undefined;
      this.activeGatherOwner = undefined;
      return {
        addressedToBot: true,
        confidence: 1,
        reason: "active gather owner requested stop",
        steps: [
          { type: "say", message: "好，我停下。" },
          {
            type: "action",
            action: {
              name: "stop",
              args: {
                reason: `Gather task stopped by '${chat.username}'`,
              },
            },
          },
        ],
      };
    }

    const pending = this.pendingGatherRequest;
    if (pending && Date.now() > pending.expiresAt) {
      this.log("gather.pending.expired", { tickId, pending });
      this.pendingGatherRequest = undefined;
    } else if (pending && samePlayer(chat.username, pending.username)) {
      const amount = parseRequestedCount(chat.message);
      if (amount !== undefined) {
        this.pendingGatherRequest = undefined;
        this.activeGatherOwner = chat.username;
        const currentCount = countWorldInventoryItems(world, pending.itemNames);
        const targetCount = currentCount + amount;
        return {
          addressedToBot: true,
          confidence: 1,
          reason: "answered pending gather amount",
          steps: [
            { type: "say", message: `好，我去砍 ${amount} 个${pending.label}，够了就告诉你。` },
            {
              type: "task",
              task: {
                title: `Collect ${amount} ${pending.label}`,
                source: "direct",
                steps: [
                  {
                    type: "collect_until_inventory",
                    blockName: pending.blockName,
                    itemNames: pending.itemNames,
                    targetCount,
                    actionCount: pending.actionCount,
                    maxDistance: pending.maxDistance,
                    description: `Collect ${pending.label} until inventory reaches ${targetCount}`,
                  },
                  { type: "say", message: `砍完了，已经拿到 ${amount} 个${pending.label}。` },
                ],
              },
            },
          ],
        };
      }
    }

    const gatherRequest = parseVagueTreeGatherRequest(chat.message, botNames, this.config.commandPrefix);
    if (!gatherRequest) {
      return undefined;
    }

    const amount = parseRequestedCount(chat.message);
    if (amount === undefined) {
      this.pendingGatherRequest = {
        actionCount: 4,
        blockName: "log",
        expiresAt: Date.now() + GATHER_REQUEST_TTL_MS,
        itemNames: LOG_ITEM_NAMES,
        label: "原木",
        maxDistance: 96,
        username: chat.username,
      };
      return {
        addressedToBot: true,
        confidence: 1,
        reason: "tree gather requested without amount",
        steps: [{ type: "say", message: "要砍多少个原木？" }],
      };
    }

    this.activeGatherOwner = chat.username;
    const currentCount = countWorldInventoryItems(world, LOG_ITEM_NAMES);
    return {
      addressedToBot: true,
      confidence: 1,
      reason: "tree gather requested with amount",
      steps: [
        { type: "say", message: `好，我去砍 ${amount} 个原木，够了就告诉你。` },
        {
          type: "task",
          task: {
            title: `Collect ${amount} logs`,
            source: "direct",
            steps: [
              {
                type: "collect_until_inventory",
                blockName: "log",
                itemNames: LOG_ITEM_NAMES,
                targetCount: currentCount + amount,
                actionCount: 4,
                maxDistance: 96,
                description: `Collect logs until inventory reaches ${currentCount + amount}`,
              },
              { type: "say", message: `砍完了，已经拿到 ${amount} 个原木。` },
            ],
          },
        },
      ],
    };
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
      nearbyDiggableBlocks: world.blocks.nearbyDiggableBlocks.slice(0, 24),
      nearbyUtilityBlocks: world.blocks.nearbyUtilityBlocks.slice(0, 16),
      nearbyDangerBlocks: world.blocks.nearbyDangerBlocks.slice(0, 16),
      nearbyContainers: world.blocks.nearbyContainers.slice(0, 16),
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

function createActionFailureReply(actionName: string, errorMessage: string): string {
  const cleaned = cleanActionErrorMessage(errorMessage);
  if (actionName === "dig_nearest_block" && cleaned.startsWith("No diggable block found")) {
    return `我附近没找到可挖的目标：${cleaned}`;
  }

  if (actionName === "attack_nearest_entity" && cleaned.startsWith("No attack target found")) {
    return `我附近没找到能打的目标：${cleaned}`;
  }

  return `这步没成：${cleaned}`;
}

function cleanActionErrorMessage(errorMessage: string): string {
  const workerErrorMatch = /"error"\s*:\s*"([^"]+)"/u.exec(errorMessage);
  const raw = workerErrorMatch?.[1] ?? errorMessage;
  return raw
    .replace(/^Action '[^']+' failed:\s*/u, "")
    .replace(/^Gateway request failed \d+:\s*/u, "")
    .trim();
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

  if (step.type === "task") {
    return {
      type: "task",
      task: step.task,
    };
  }

  return {
    type: "action",
    action: step.action,
  };
}

function parseVagueTreeGatherRequest(message: string, botNames: string[], commandPrefix: string): boolean {
  const normalized = normalizeMessage(message);
  if (!isMessageAddressed(normalized, botNames, commandPrefix)) {
    return false;
  }

  return (
    normalized.includes("砍树") ||
    normalized.includes("砍木头") ||
    normalized.includes("伐木") ||
    normalized.includes("chop tree") ||
    normalized.includes("cut tree") ||
    normalized.includes("collect wood") ||
    normalized.includes("get wood")
  );
}

function parseStopRequest(message: string): boolean {
  const normalized = normalizeMessage(message);
  return (
    normalized === "停" ||
    normalized === "停止" ||
    normalized === "停下" ||
    normalized === "stop" ||
    normalized === "cancel" ||
    normalized.includes(" 停止") ||
    normalized.includes(" 停下") ||
    normalized.includes(" stop") ||
    normalized.includes(" cancel")
  );
}

function parseRequestedCount(message: string): number | undefined {
  const normalized = normalizeMessage(message);
  const match = /(?:^|[^\d])(\d{1,3})(?:\s*(?:个|块|根|logs?|wood)?)?(?:$|[^\d])/iu.exec(normalized);
  if (!match?.[1]) {
    return undefined;
  }

  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) && value > 0 ? Math.min(value, 512) : undefined;
}

function isMessageAddressed(normalizedMessage: string, botNames: string[], commandPrefix: string): boolean {
  const prefix = commandPrefix.trim().toLowerCase();
  if (prefix && normalizedMessage.startsWith(prefix.toLowerCase())) {
    return true;
  }

  return botNames.some((name) => {
    const normalizedName = name.trim().toLowerCase();
    return normalizedName.length > 0 && normalizedMessage.includes(normalizedName);
  });
}

function countWorldInventoryItems(world: WorldSnapshot, itemNames: string[]): number {
  const names = new Set(itemNames.map(normalizeItemName));
  return world.self.inventory
    .filter((item) => names.has(normalizeItemName(item.name)) || (item.displayName ? names.has(normalizeItemName(item.displayName)) : false))
    .reduce((total, item) => total + item.count, 0);
}

function normalizeMessage(message: string): string {
  return message.trim().toLowerCase().replace(/\s+/gu, " ");
}

function normalizeItemName(value: string): string {
  return value.trim().toLowerCase().replace(/^minecraft:/u, "").replace(/\s+/gu, "_");
}

function samePlayer(left: string, right: string): boolean {
  return left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0;
}
