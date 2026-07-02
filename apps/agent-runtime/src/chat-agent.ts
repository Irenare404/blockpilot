import { asErrorMessage, createId, type BotCapability, type ChatMessageSnapshot, type WorldSnapshot } from "@blockpilot/core";
import type { AgentDecisionLogger } from "./decision-log.js";
import type { GatewayClient } from "./gateway-client.js";
import type { AgentMemorySnapshot, MemoryStore } from "./memory-store.js";
import type { AgentPlan, AgentPlanStep, AgentPlanner, PlannerContext } from "./planner.js";
import type { AgentTaskQueue, AgentTaskStep } from "./task-queue.js";

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

interface GatherSpec {
  actionCount: number;
  blockName: string;
  confirmTimeoutMs?: number;
  itemNames: string[];
  label: string;
  maxDistance: number;
}

interface BuildSpec {
  materialItemName?: string;
  preset?: "starter_hut" | "platform" | "pillar";
}

type PendingGoalRequest =
  | {
      type: "gather";
      expiresAt: number;
      spec: GatherSpec;
      username: string;
    }
  | {
      type: "build";
      expiresAt: number;
      spec: BuildSpec;
      username: string;
    };

const GOAL_REQUEST_TTL_MS = 120_000;

const GATHER_SPECS: GatherSpec[] = [
  {
    actionCount: 1,
    blockName: "log",
    confirmTimeoutMs: 12_000,
    itemNames: ["log", "oak_log", "spruce_log", "birch_log", "jungle_log", "acacia_log", "dark_oak_log", "mangrove_log", "cherry_log", "pale_oak_log"],
    label: "\u539f\u6728",
    maxDistance: 96,
  },
  {
    actionCount: 8,
    blockName: "dirt,grass,grass_block",
    itemNames: ["dirt", "grass", "grass_block", "coarse_dirt", "rooted_dirt", "podzol"],
    label: "\u6ce5\u571f",
    maxDistance: 64,
  },
  {
    actionCount: 6,
    blockName: "stone,cobblestone,deepslate",
    itemNames: ["stone", "cobblestone", "deepslate", "cobbled_deepslate"],
    label: "\u77f3\u5934",
    maxDistance: 64,
  },
  {
    actionCount: 8,
    blockName: "sand",
    itemNames: ["sand", "red_sand"],
    label: "\u6c99\u5b50",
    maxDistance: 64,
  },
  {
    actionCount: 8,
    blockName: "snow,snow_block",
    itemNames: ["snowball", "snow", "snow_block"],
    label: "\u96ea",
    maxDistance: 64,
  },
];

export class ChatAgent {
  private readonly client: GatewayClient;
  private readonly planner: AgentPlanner;
  private readonly config: ChatAgentConfig;
  private readonly handledChatKeys: string[] = [];
  private readonly handledChatSet = new Set<string>();
  private pendingGoalRequest: PendingGoalRequest | undefined;
  private activeGoalOwner: string | undefined;
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
    if (this.activeGoalOwner && this.config.taskQueue && !this.config.taskQueue.hasRunnableTask()) {
      this.activeGoalOwner = undefined;
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

    const directPlan = this.createDirectGoalPlan(nextChat, world, botNames, tickId);
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
      this.log("tick.end", { tickId, outcome: "direct_goal_plan" });
      return;
    }

    const smallTalkPlan = this.createDirectSmallTalkPlan(nextChat, botNames);
    if (smallTalkPlan) {
      this.log("planner.result", {
        tickId,
        chat: compactChat(nextChat),
        addressedToBot: smallTalkPlan.addressedToBot,
        confidence: smallTalkPlan.confidence,
        reason: smallTalkPlan.reason,
        steps: smallTalkPlan.steps.map(compactStep),
      });
      await this.executePlan(smallTalkPlan, world, tickId);
      this.log("tick.end", { tickId, outcome: "direct_smalltalk_plan" });
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

  private createDirectGoalPlan(
    chat: ChatMessageSnapshot,
    world: WorldSnapshot,
    botNames: string[],
    tickId: string,
  ): AgentPlan | undefined {
    const stopRequested = parseStopRequest(chat.message);
    if (stopRequested && this.activeGoalOwner && samePlayer(chat.username, this.activeGoalOwner)) {
      this.pendingGoalRequest = undefined;
      this.activeGoalOwner = undefined;
      return {
        addressedToBot: true,
        confidence: 1,
        reason: "active goal owner requested stop",
        steps: [
          { type: "say", message: "\u597d\uff0c\u6211\u505c\u4e0b\u3002" },
          {
            type: "action",
            action: {
              name: "stop",
              args: {
                reason: `Goal task stopped by ${chat.username}`,
              },
            },
          },
        ],
      };
    }

    const pending = this.pendingGoalRequest;
    if (pending && Date.now() > pending.expiresAt) {
      this.log("goal.pending.expired", { tickId, pending });
      this.pendingGoalRequest = undefined;
    } else if (pending && samePlayer(chat.username, pending.username)) {
      const pendingPlan = this.createPendingGoalAnswerPlan(pending, chat, world);
      if (pendingPlan) {
        return pendingPlan;
      }
    }

    const addressed = isMessageAddressed(normalizeMessage(chat.message), botNames, this.config.commandPrefix);
    if (!addressed) {
      return undefined;
    }

    const gatherSpec = parseGatherSpec(chat.message);
    if (gatherSpec) {
      const amount = parseRequestedCount(chat.message);
      const continuous = parseContinuousRequest(chat.message);
      if (amount === undefined && !continuous) {
        this.pendingGoalRequest = {
          type: "gather",
          expiresAt: Date.now() + GOAL_REQUEST_TTL_MS,
          spec: gatherSpec,
          username: chat.username,
        };
        return {
          addressedToBot: true,
          confidence: 1,
          reason: "gather requested without amount",
          steps: [{ type: "say", message: `\u8981\u6536\u96c6\u591a\u5c11\u4e2a${gatherSpec.label}\uff1f` }],
        };
      }

      return this.createGatherTaskPlan(chat.username, gatherSpec, amount, world, continuous);
    }

    const buildSpec = parseBuildSpec(chat.message);
    if (buildSpec) {
      if (!buildSpec.preset) {
        this.pendingGoalRequest = {
          type: "build",
          expiresAt: Date.now() + GOAL_REQUEST_TTL_MS,
          spec: buildSpec,
          username: chat.username,
        };
        return {
          addressedToBot: true,
          confidence: 1,
          reason: "build requested without preset",
          steps: [{ type: "say", message: "\u8981\u76d6\u54ea\u79cd\uff1f\u53ef\u4ee5\u8bf4\u5c0f\u5c4b\u3001\u5e73\u53f0\u6216\u67f1\u5b50\u3002" }],
        };
      }

      if (!buildSpec.materialItemName) {
        this.pendingGoalRequest = {
          type: "build",
          expiresAt: Date.now() + GOAL_REQUEST_TTL_MS,
          spec: buildSpec,
          username: chat.username,
        };
        return {
          addressedToBot: true,
          confidence: 1,
          reason: "build requested without material",
          steps: [{ type: "say", message: "\u7528\u4ec0\u4e48\u6750\u6599\u76d6\uff1f\u6bd4\u5982\u6728\u677f\u3001\u6ce5\u571f\u6216\u77f3\u5934\u3002" }],
        };
      }

      return this.createBuildTaskPlan(chat.username, buildSpec.preset, buildSpec.materialItemName, world);
    }

    return undefined;
  }

  private createPendingGoalAnswerPlan(pending: PendingGoalRequest, chat: ChatMessageSnapshot, world: WorldSnapshot): AgentPlan | undefined {
    if (pending.type === "gather") {
      const amount = parseRequestedCount(chat.message);
      const continuous = parseContinuousRequest(chat.message);
      if (amount === undefined && !continuous) {
        return undefined;
      }

      this.pendingGoalRequest = undefined;
      return this.createGatherTaskPlan(chat.username, pending.spec, amount, world, continuous);
    }

    const preset = pending.spec.preset ?? parseBuildPreset(chat.message);
    const materialItemName = pending.spec.materialItemName ?? parseBuildMaterial(chat.message);
    if (!preset || !materialItemName) {
      return undefined;
    }

    this.pendingGoalRequest = undefined;
    return this.createBuildTaskPlan(chat.username, preset, materialItemName, world);
  }

  private createGatherTaskPlan(
    username: string,
    spec: GatherSpec,
    amount: number | undefined,
    world: WorldSnapshot,
    continuous: boolean,
  ): AgentPlan {
    this.activeGoalOwner = username;
    const currentCount = countWorldInventoryItems(world, spec.itemNames);
    const targetCount = amount === undefined ? undefined : currentCount + amount;
    const sayStart =
      amount === undefined
        ? `\u597d\uff0c\u6211\u53bb\u6301\u7eed\u6536\u96c6${spec.label}\uff0c\u627e\u4e0d\u5230\u6216\u4f60\u8bf4\u505c\u6b62\u5c31\u505c\u3002`
        : `\u597d\uff0c\u6211\u53bb\u6536\u96c6 ${amount} \u4e2a${spec.label}\uff0c\u591f\u4e86\u5c31\u544a\u8bc9\u4f60\u3002`;
    const sayDone =
      amount === undefined
        ? `\u5b8c\u6210\u4e86\uff0c\u9644\u8fd1\u6682\u65f6\u627e\u4e0d\u5230\u66f4\u591a${spec.label}\u3002`
        : `\u5b8c\u6210\u4e86\uff0c\u5df2\u7ecf\u6536\u96c6\u5230 ${amount} \u4e2a${spec.label}\u3002`;
    return {
      addressedToBot: true,
      confidence: 1,
      reason: "gather goal ready",
      steps: [
        { type: "say", message: sayStart },
        {
          type: "task",
          task: {
            title: amount === undefined ? `Collect all reachable ${spec.label}` : `Collect ${amount} ${spec.label}`,
            source: "direct",
            steps: [
              {
                type: "collect_until_inventory",
                blockName: spec.blockName,
                itemNames: spec.itemNames,
                ...(targetCount === undefined ? {} : { targetCount }),
                actionCount: spec.actionCount,
                ...(spec.confirmTimeoutMs === undefined ? {} : { confirmTimeoutMs: spec.confirmTimeoutMs }),
                maxDistance: spec.maxDistance,
                stopWhenNoTarget: targetCount === undefined || continuous,
                description:
                  targetCount === undefined
                    ? `Collect reachable ${spec.label} until stopped or no target remains`
                    : `Collect ${spec.label} until inventory reaches ${targetCount}`,
              },
              { type: "say", message: sayDone },
            ],
          },
        },
      ],
    };
  }

  private createBuildTaskPlan(
    username: string,
    preset: "starter_hut" | "platform" | "pillar",
    materialItemName: string,
    world: WorldSnapshot,
  ): AgentPlan {
    this.activeGoalOwner = username;
    const requiredCount = getBuildPresetRequiredCount(preset);
    const preparationSteps = createMaterialPreparationSteps(materialItemName, requiredCount, world);
    return {
      addressedToBot: true,
      confidence: 1,
      reason: "build goal ready",
      steps: [
        { type: "say", message: `\u597d\uff0c\u6211\u7528${formatMaterialLabel(materialItemName)}\u76d6${formatPresetLabel(preset)}\u3002` },
        {
          type: "task",
          task: {
            title: `Build ${preset}`,
            source: "direct",
            steps: [
              ...preparationSteps,
              {
                type: "action",
                action: {
                  name: "build_preset",
                  args: {
                    preset,
                    materialItemName,
                  },
                },
                description: `Build ${preset} with ${materialItemName}`,
              },
              { type: "say", message: "\u76d6\u597d\u4e86\u3002" },
            ],
          },
        },
      ],
    };
  }

  private createDirectSmallTalkPlan(chat: ChatMessageSnapshot, botNames: string[]): AgentPlan | undefined {
    const normalized = normalizeMessage(chat.message);
    if (!isMessageAddressed(normalized, botNames, this.config.commandPrefix)) {
      return undefined;
    }

    if (!isGreetingMessage(normalized, botNames, this.config.commandPrefix)) {
      return undefined;
    }

    return {
      addressedToBot: true,
      confidence: 1,
      reason: "direct greeting",
      steps: [{ type: "say", message: "\u4f60\u597d\uff0c\u6211\u5728\u3002" }],
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
    return `\u6211\u9644\u8fd1\u6ca1\u627e\u5230\u53ef\u6316\u7684\u76ee\u6807\uff1a${cleaned}`;
  }

  if (actionName === "attack_nearest_entity" && cleaned.startsWith("No attack target found")) {
    return `\u6211\u9644\u8fd1\u6ca1\u627e\u5230\u80fd\u6253\u7684\u76ee\u6807\uff1a${cleaned}`;
  }

  return `\u8fd9\u6b65\u6ca1\u6210\uff1a${cleaned}`;
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

function parseGatherSpec(message: string): GatherSpec | undefined {
  const normalized = normalizeMessage(message);
  if (!containsAny(normalized, ["dig", "mine", "collect", "get", "chop", "cut", "\u6316", "\u91c7\u96c6", "\u6536\u96c6", "\u62ff", "\u83b7\u53d6", "\u780d", "\u4f10"])) {
    return undefined;
  }

  return GATHER_SPECS.find((spec) => matchesGatherSpec(normalized, spec));
}

function isGreetingMessage(normalizedMessage: string, botNames: string[], commandPrefix: string): boolean {
  let cleaned = normalizedMessage;
  const prefix = commandPrefix.trim().toLowerCase();
  if (prefix && cleaned.startsWith(prefix)) {
    cleaned = cleaned.slice(prefix.length).trim();
  }

  for (const name of botNames) {
    const normalizedName = name.trim().toLowerCase();
    if (normalizedName) {
      cleaned = cleaned.replaceAll(normalizedName, " ").trim();
    }
  }

  cleaned = cleaned.replace(/[，。！？,.!?]/gu, "").trim();
  return ["hi", "hello", "hey", "\u4f60\u597d", "\u55e8", "\u5728\u5417", "\u5728\u4e0d\u5728"].includes(cleaned);
}

function matchesGatherSpec(normalized: string, spec: GatherSpec): boolean {
  if (spec.blockName.includes("log")) {
    return containsAny(normalized, ["tree", "wood", "log", "\u6811", "\u6728\u5934", "\u539f\u6728", "\u780d\u6811", "\u4f10\u6728"]);
  }
  if (spec.blockName.includes("dirt")) {
    return containsAny(normalized, ["dirt", "grass", "\u6ce5\u571f", "\u571f", "\u8349\u65b9\u5757"]);
  }
  if (spec.blockName.includes("stone")) {
    return containsAny(normalized, ["stone", "cobble", "deepslate", "\u77f3\u5934", "\u5706\u77f3", "\u6df1\u677f\u5ca9"]);
  }
  if (spec.blockName.includes("sand")) {
    return containsAny(normalized, ["sand", "\u6c99", "\u6c99\u5b50"]);
  }
  if (spec.blockName.includes("snow")) {
    return containsAny(normalized, ["snow", "\u96ea", "\u96ea\u5757"]);
  }

  return false;
}

function parseBuildSpec(message: string): BuildSpec | undefined {
  const normalized = normalizeMessage(message);
  if (!containsAny(normalized, ["build", "construct", "make", "\u76d6", "\u5efa", "\u5efa\u9020", "\u642d"])) {
    return undefined;
  }

  const spec: BuildSpec = {};
  const preset = parseBuildPreset(message);
  const materialItemName = parseBuildMaterial(message);
  if (preset) {
    spec.preset = preset;
  }
  if (materialItemName) {
    spec.materialItemName = materialItemName;
  }
  return spec;
}

function createMaterialPreparationSteps(materialItemName: string, requiredCount: number, world: WorldSnapshot): AgentTaskStep[] {
  const currentCount = countWorldInventoryItems(world, [materialItemName]);
  if (currentCount >= requiredCount) {
    return [];
  }

  const missingCount = requiredCount - currentCount;
  if (materialItemName === "oak_planks") {
    const craftCount = Math.ceil(missingCount / 4);
    const logSpec = GATHER_SPECS[0];
    const collectLogsStep: AgentTaskStep = {
      type: "collect_until_inventory",
      blockName: "log",
      itemNames: logSpec?.itemNames ?? ["log"],
      targetCount: countWorldInventoryItems(world, logSpec?.itemNames ?? ["log"]) + craftCount,
      actionCount: logSpec?.actionCount ?? 1,
      maxDistance: logSpec?.maxDistance ?? 96,
      description: `Collect logs for ${requiredCount} planks`,
    };
    if (logSpec?.confirmTimeoutMs !== undefined) {
      collectLogsStep.confirmTimeoutMs = logSpec.confirmTimeoutMs;
    }

    return [
      collectLogsStep,
      {
        type: "action",
        action: {
          name: "craft_item",
          args: {
            itemName: "oak_planks",
            count: craftCount,
          },
        },
        description: `Craft ${craftCount} batches of planks`,
      },
    ];
  }

  const gatherSpec = getGatherSpecForMaterial(materialItemName);
  if (!gatherSpec) {
    return [];
  }

  return [
    {
      type: "collect_until_inventory",
      blockName: gatherSpec.blockName,
      itemNames: gatherSpec.itemNames,
      targetCount: requiredCount,
      actionCount: gatherSpec.actionCount,
      maxDistance: gatherSpec.maxDistance,
      description: `Collect ${requiredCount} ${materialItemName} for build`,
    },
  ];
}

function getGatherSpecForMaterial(materialItemName: string): GatherSpec | undefined {
  switch (materialItemName) {
    case "dirt":
      return GATHER_SPECS.find((spec) => spec.blockName.includes("dirt"));
    case "cobblestone":
      return GATHER_SPECS.find((spec) => spec.blockName.includes("stone"));
    case "sand":
      return GATHER_SPECS.find((spec) => spec.blockName.includes("sand"));
    default:
      return undefined;
  }
}

function getBuildPresetRequiredCount(preset: "starter_hut" | "platform" | "pillar"): number {
  switch (preset) {
    case "platform":
      return 25;
    case "pillar":
      return 4;
    case "starter_hut":
      return 96;
  }
}

function parseBuildPreset(message: string): "starter_hut" | "platform" | "pillar" | undefined {
  const normalized = normalizeMessage(message);
  if (containsAny(normalized, ["house", "hut", "home", "\u623f\u5b50", "\u5c0f\u5c4b", "\u6728\u5c4b"])) {
    return "starter_hut";
  }
  if (containsAny(normalized, ["platform", "floor", "\u5e73\u53f0", "\u5730\u677f"])) {
    return "platform";
  }
  if (containsAny(normalized, ["pillar", "tower", "\u67f1", "\u67f1\u5b50", "\u5854"])) {
    return "pillar";
  }
  return undefined;
}

function parseBuildMaterial(message: string): string | undefined {
  const normalized = normalizeMessage(message);
  if (containsAny(normalized, ["oak_planks", "planks", "wood plank", "\u6728\u677f"])) {
    return "oak_planks";
  }
  if (containsAny(normalized, ["dirt", "\u6ce5\u571f", "\u571f"])) {
    return "dirt";
  }
  if (containsAny(normalized, ["cobblestone", "stone", "\u5706\u77f3", "\u77f3\u5934"])) {
    return "cobblestone";
  }
  if (containsAny(normalized, ["sand", "\u6c99", "\u6c99\u5b50"])) {
    return "sand";
  }
  return undefined;
}

function formatPresetLabel(preset: "starter_hut" | "platform" | "pillar"): string {
  switch (preset) {
    case "starter_hut":
      return "\u5c0f\u5c4b";
    case "platform":
      return "\u5e73\u53f0";
    case "pillar":
      return "\u67f1\u5b50";
  }
}

function formatMaterialLabel(materialItemName: string): string {
  switch (materialItemName) {
    case "oak_planks":
      return "\u6728\u677f";
    case "dirt":
      return "\u6ce5\u571f";
    case "cobblestone":
      return "\u5706\u77f3";
    case "sand":
      return "\u6c99\u5b50";
    default:
      return materialItemName;
  }
}

function parseStopRequest(message: string): boolean {
  const normalized = normalizeMessage(message);
  return containsAny(normalized, ["stop", "cancel", "\u505c", "\u505c\u6b62", "\u505c\u4e0b", "\u522b\u5f04\u4e86"]);
}

function parseContinuousRequest(message: string): boolean {
  const normalized = normalizeMessage(message);
  return containsAny(normalized, [
    "all",
    "everything",
    "until stop",
    "until i stop",
    "keep",
    "forever",
    "\u6240\u6709",
    "\u5168\u90e8",
    "\u5168\u90fd",
    "\u4e00\u76f4",
    "\u6301\u7eed",
    "\u76f4\u5230\u505c",
    "\u76f4\u5230\u6211\u505c",
    "\u5230\u6211\u53eb\u505c",
    "\u5230\u6211\u8bf4\u505c",
    "\u6316\u5b8c",
    "\u780d\u5b8c",
    "\u91c7\u5b8c",
    "\u6ee1\u4e3a\u6b62",
  ]);
}

function parseRequestedCount(message: string): number | undefined {
  const normalized = normalizeMessage(message);
  const match = /(?:^|[^\d])(\d{1,3})(?:\s*(?:\u4e2a|\u5757|\u6839|logs?|wood|blocks?)?)?(?:$|[^\d])/iu.exec(normalized);
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

function containsAny(value: string, needles: string[]): boolean {
  return needles.some((needle) => value.includes(needle));
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
