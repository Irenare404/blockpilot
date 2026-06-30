import type { BotAction, BotCapability, ChatMessageSnapshot, WorldSnapshot } from "@blockpilot/core";
import type { GatewayClient } from "./gateway-client.js";

export interface RuleAgentConfig {
  botId: string;
  commandPrefix: string;
}

type AgentCommand =
  | {
      name: "follow";
      chat: ChatMessageSnapshot;
    }
  | {
      name: "help" | "status" | "stop" | "where" | "world";
      chat: ChatMessageSnapshot;
    };

const HELP_ALIASES = new Set(["", "help", "?", "\u5E2E\u52A9"]);
const STATUS_ALIASES = new Set(["status", "\u72B6\u6001", "\u4EFB\u52A1"]);
const WHERE_ALIASES = new Set([
  "where",
  "position",
  "pos",
  "\u5750\u6807",
  "\u5728\u54EA",
  "\u4F60\u5728\u54EA",
]);
const WORLD_ALIASES = new Set(["world", "\u9644\u8FD1", "\u73A9\u5BB6"]);
const FOLLOW_ALIASES = new Set([
  "follow",
  "follow me",
  "\u8DDF\u968F",
  "\u8DDF\u7740\u6211",
  "\u8FC7\u6765",
]);
const STOP_ALIASES = new Set(["stop", "cancel", "\u505C\u6B62", "\u505C\u4E0B"]);

export class RuleAgent {
  private readonly client: GatewayClient;
  private readonly config: RuleAgentConfig;
  private readonly handledChatKeys: string[] = [];
  private readonly handledChatSet = new Set<string>();

  constructor(client: GatewayClient, config: RuleAgentConfig) {
    this.client = client;
    this.config = config;
  }

  async tick(): Promise<void> {
    const world = await this.client.getWorld();

    for (const chat of sortChat(world.recentChat)) {
      if (isSamePlayer(chat.username, this.config.botId)) {
        continue;
      }

      const key = createChatKey(chat);
      if (this.handledChatSet.has(key)) {
        continue;
      }

      this.rememberHandledChat(key);

      const command = this.parseCommand(chat);
      if (!command) {
        continue;
      }

      await this.executeCommand(command, world);
    }
  }

  private parseCommand(chat: ChatMessageSnapshot): AgentCommand | undefined {
    const message = normalizeSpacing(chat.message);
    const prefix = normalizeSpacing(this.config.commandPrefix);

    if (!message.startsWith(prefix)) {
      return undefined;
    }

    const rest = message.slice(prefix.length);
    if (!isCommandBoundary(rest)) {
      return undefined;
    }

    const command = normalizeCommand(rest);

    if (HELP_ALIASES.has(command)) {
      return { name: "help", chat };
    }

    if (STATUS_ALIASES.has(command)) {
      return { name: "status", chat };
    }

    if (WHERE_ALIASES.has(command)) {
      return { name: "where", chat };
    }

    if (WORLD_ALIASES.has(command)) {
      return { name: "world", chat };
    }

    if (FOLLOW_ALIASES.has(command)) {
      return { name: "follow", chat };
    }

    if (STOP_ALIASES.has(command)) {
      return { name: "stop", chat };
    }

    return { name: "help", chat };
  }

  private async executeCommand(command: AgentCommand, world: WorldSnapshot): Promise<void> {
    switch (command.name) {
      case "help":
        await this.client.chat(createHelpMessage(world.capabilities, this.config.commandPrefix));
        return;
      case "status":
        await this.client.chat(createStatusMessage(world));
        return;
      case "where":
        await this.runIfAvailable(
          world,
          {
            name: "report_position",
            args: {},
          },
          () => this.client.chat(createPositionMessage(world)),
        );
        return;
      case "world":
        await this.client.chat(createWorldMessage(world));
        return;
      case "follow":
        await this.runIfAvailable(
          world,
          {
            name: "follow_player",
            args: {
              playerName: command.chat.username,
              distance: 2,
            },
          },
          () => this.client.chat("I cannot follow yet; follow_player is not available."),
        );
        return;
      case "stop":
        await this.runIfAvailable(
          world,
          {
            name: "stop",
            args: {
              reason: `Agent stop command from '${command.chat.username}'`,
            },
          },
          () => this.client.chat("I cannot stop yet; stop is not available."),
        );
        return;
    }
  }

  private async runIfAvailable(world: WorldSnapshot, action: BotAction, fallback: () => Promise<unknown>): Promise<void> {
    if (!hasCapability(world.capabilities, action.name)) {
      await fallback();
      return;
    }

    await this.client.runAction(action);
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

function createChatKey(chat: ChatMessageSnapshot): string {
  return `${chat.receivedAt}:${chat.username}:${chat.message}`;
}

function createHelpMessage(capabilities: BotCapability[], prefix: string): string {
  const names = capabilities.map((capability) => capability.name).sort().join(", ");
  return `Agent commands: ${prefix} help/status/where/world/follow/stop. Tools: ${names || "none"}.`;
}

function createPositionMessage(world: WorldSnapshot): string {
  const position = world.status.position;
  if (!position) {
    return "I do not know my position yet.";
  }

  return `Position: ${position.x}, ${position.y}, ${position.z} (${world.status.dimension ?? "unknown"})`;
}

function createStatusMessage(world: WorldSnapshot): string {
  const health = world.status.health ?? "?";
  const food = world.status.food ?? "?";
  const position = world.status.position
    ? `${world.status.position.x}, ${world.status.position.y}, ${world.status.position.z}`
    : "unknown";
  const task = world.currentTask ? `${world.currentTask.actionName}:${world.currentTask.state}` : "idle";

  return `Status: hp=${health}, food=${food}, pos=${position}, task=${task}.`;
}

function createWorldMessage(world: WorldSnapshot): string {
  if (world.nearbyPlayers.length === 0) {
    return "No nearby visible players.";
  }

  const players = world.nearbyPlayers
    .slice(0, 5)
    .map((player) => `${player.username}${typeof player.distance === "number" ? `(${player.distance})` : ""}`)
    .join(", ");

  return `Nearby: ${players}.`;
}

function hasCapability(capabilities: BotCapability[], actionName: string): boolean {
  return capabilities.some((capability) => capability.name === actionName);
}

function isSamePlayer(left: string, right: string): boolean {
  return left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0;
}

function isCommandBoundary(rest: string): boolean {
  return rest.length === 0 || /^[\s\uFF0C\u3002\uFF01\uFF1F,.!?]/u.test(rest);
}

function normalizeCommand(message: string): string {
  return normalizeSpacing(message).replace(/[\uFF0C\u3002\uFF01\uFF1F,.!?]/gu, "").trim();
}

function normalizeSpacing(message: string): string {
  return message.trim().toLowerCase().replace(/\s+/gu, " ");
}

function sortChat(chat: ChatMessageSnapshot[]): ChatMessageSnapshot[] {
  return [...chat].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
}
