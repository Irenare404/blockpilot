import { asErrorMessage } from "@blockpilot/core";
import type { ChatEvent, WorkerPlugin, WorkerPluginConfig } from "../plugin-runtime.js";

type ChatIntent =
  | {
      name: "follow_player";
      playerName: string;
      distance: number;
    }
  | {
      name: "stop";
    };

const FOLLOW_COMMANDS = [
  "come",
  "come here",
  "follow",
  "follow me",
  "\u8FC7\u6765",
  "\u6765",
  "\u6765\u6211\u8FD9",
  "\u6765\u6211\u8FD9\u91CC",
  "\u8DDF\u6211",
  "\u8DDF\u7740\u6211",
  "\u8DDF\u968F\u6211",
];

const STOP_COMMANDS = [
  "stop",
  "cancel",
  "\u505C\u6B62",
  "\u505C\u4E0B",
  "\u522B\u8DDF\u4E86",
  "\u522B\u8DDF\u7740\u6211",
];

export const chatIntentsPlugin: WorkerPlugin = {
  id: "blockpilot.chat-intents",
  name: "Chat Intents",
  setup(ctx) {
    ctx.events.onChat(async (event) => {
      const intent = parseChatIntent(ctx.config, event);
      if (!intent) {
        return;
      }

      try {
        if (intent.name === "follow_player") {
          const result = await ctx.actions.execute({
            name: "follow_player",
            args: {
              playerName: intent.playerName,
              distance: intent.distance,
            },
          });
          ctx.minecraft.chat(result.message ?? `Following ${intent.playerName}`);
          return;
        }

        await ctx.actions.execute({
          name: "stop",
          args: {
            reason: `Chat stop command from '${event.username}'`,
          },
        });
        ctx.minecraft.chat("Stopped.");
      } catch (error) {
        const errorMessage = asErrorMessage(error);
        ctx.emitEvent("intent.error", errorMessage, {
          username: event.username,
          message: event.message,
        });
        ctx.minecraft.chat(errorMessage);
      }
    });
  },
};

function parseChatIntent(config: WorkerPluginConfig, event: ChatEvent): ChatIntent | undefined {
  const normalized = normalizeChatMessage(event.message);
  if (!normalized) {
    return undefined;
  }

  if (isStopIntent(config, normalized)) {
    return {
      name: "stop",
    };
  }

  if (isFollowIntent(config, normalized)) {
    return {
      name: "follow_player",
      playerName: event.username,
      distance: 2,
    };
  }

  return undefined;
}

function isFollowIntent(config: WorkerPluginConfig, normalized: string): boolean {
  if (FOLLOW_COMMANDS.includes(normalized)) {
    return true;
  }

  return isAddressedToBot(config, normalized) && containsAny(normalized, FOLLOW_COMMANDS);
}

function isStopIntent(config: WorkerPluginConfig, normalized: string): boolean {
  if (STOP_COMMANDS.includes(normalized)) {
    return true;
  }

  return isAddressedToBot(config, normalized) && containsAny(normalized, STOP_COMMANDS);
}

function isAddressedToBot(config: WorkerPluginConfig, normalized: string): boolean {
  const botName = config.username.toLowerCase();
  const botId = config.botId.toLowerCase();
  return normalized.includes(botName) || normalized.includes(botId) || normalized.startsWith("bot ") || normalized.startsWith("bp ");
}

function containsAny(input: string, options: string[]): boolean {
  return options.some((option) => input.includes(option));
}

function normalizeChatMessage(message: string): string {
  return message.trim().toLowerCase().replace(/[\uFF0C\u3002\uFF01\uFF1F,.!?]/gu, "").replace(/\s+/gu, " ");
}
