import type { BotCapability, ChatMessageSnapshot, WorldSnapshot } from "@blockpilot/core";
import type { GatewayClient } from "./gateway-client.js";
import type { AgentPlan, AgentPlanner } from "./planner.js";

export interface SafetyHandler {
  handle(world: WorldSnapshot): Promise<boolean>;
}

export interface ChatAgentConfig {
  botId: string;
  commandPrefix: string;
  aliases: string[];
  allowedActionNames: string[];
  responseDedupMs: number;
  safety?: SafetyHandler;
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
    const world = await this.client.getWorld();
    const botUsername = world.status.username ?? this.config.botId;
    const botNames = createBotNames(this.config.botId, botUsername, this.config.aliases);

    if (await this.config.safety?.handle(world)) {
      return;
    }

    const nextChat = this.takeLatestUnhandledChat(world.recentChat, botNames);
    if (!nextChat) {
      return;
    }

    const plan = await this.planner.plan({
      botId: this.config.botId,
      botUsername,
      botNames,
      commandPrefix: this.config.commandPrefix,
      allowedActionNames: this.config.allowedActionNames,
      chat: nextChat,
      world,
    });

    if (!plan.addressedToBot) {
      return;
    }

    await this.executePlan(plan, world);
  }

  private async executePlan(plan: AgentPlan, world: WorldSnapshot): Promise<void> {
    for (const step of plan.steps) {
      if (step.type === "say") {
        if (!this.canRunAction(world.capabilities, "chat")) {
          console.warn("[agent-runtime] skipped unavailable action 'chat'");
          continue;
        }

        if (this.isDuplicateReply(step.message)) {
          console.warn("[agent-runtime] skipped duplicate chat reply");
          continue;
        }

        this.rememberReply(step.message);
        await this.client.chat(step.message);
        continue;
      }

      if (!this.canRunAction(world.capabilities, step.action.name)) {
        console.warn(`[agent-runtime] skipped unavailable action '${step.action.name}'`);
        continue;
      }

      await this.client.runAction(step.action);
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
