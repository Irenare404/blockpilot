import type { BotCapability, ChatMessageSnapshot, WorldSnapshot } from "@blockpilot/core";
import type { GatewayClient } from "./gateway-client.js";
import type { AgentPlan, AgentPlanner } from "./planner.js";

export interface ChatAgentConfig {
  botId: string;
  commandPrefix: string;
  aliases: string[];
  allowedActionNames: string[];
}

export class ChatAgent {
  private readonly client: GatewayClient;
  private readonly planner: AgentPlanner;
  private readonly config: ChatAgentConfig;
  private readonly handledChatKeys: string[] = [];
  private readonly handledChatSet = new Set<string>();

  constructor(client: GatewayClient, planner: AgentPlanner, config: ChatAgentConfig) {
    this.client = client;
    this.planner = planner;
    this.config = config;
  }

  async tick(): Promise<void> {
    const world = await this.client.getWorld();
    const botUsername = world.status.username ?? this.config.botId;
    const botNames = createBotNames(this.config.botId, botUsername, this.config.aliases);

    for (const chat of sortChat(world.recentChat)) {
      if (isOwnChat(chat.username, botNames)) {
        continue;
      }

      const key = createChatKey(chat);
      if (this.handledChatSet.has(key)) {
        continue;
      }

      this.rememberHandledChat(key);

      const plan = await this.planner.plan({
        botId: this.config.botId,
        botUsername,
        botNames,
        commandPrefix: this.config.commandPrefix,
        allowedActionNames: this.config.allowedActionNames,
        chat,
        world,
      });

      if (!plan.addressedToBot) {
        continue;
      }

      await this.executePlan(plan, world);
    }
  }

  private async executePlan(plan: AgentPlan, world: WorldSnapshot): Promise<void> {
    for (const step of plan.steps) {
      if (step.type === "say") {
        if (!this.canRunAction(world.capabilities, "chat")) {
          console.warn("[agent-runtime] skipped unavailable action 'chat'");
          continue;
        }

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

  private canRunAction(capabilities: BotCapability[], actionName: string): boolean {
    return this.config.allowedActionNames.includes(actionName) && capabilities.some((capability) => capability.name === actionName);
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

function isOwnChat(username: string, botNames: string[]): boolean {
  return botNames.some((name) => username.localeCompare(name, undefined, { sensitivity: "accent" }) === 0);
}

function sortChat(chat: ChatMessageSnapshot[]): ChatMessageSnapshot[] {
  return [...chat].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
}
