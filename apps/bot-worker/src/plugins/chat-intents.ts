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
  const directCommands = new Set([
    "come",
    "come here",
    "follow",
    "follow me",
    "过来",
    "来",
    "来我这",
    "来我这里",
    "跟我",
    "跟着我",
    "跟随我",
  ]);

  if (directCommands.has(normalized)) {
    return true;
  }

  return isAddressedToBot(config, normalized) && /(?:come here|follow me|过来|来我这|来我这里|跟我|跟着我|跟随我)/u.test(normalized);
}

function isStopIntent(config: WorkerPluginConfig, normalized: string): boolean {
  const directCommands = new Set(["stop", "cancel", "停止", "停下", "别跟了", "别跟着我"]);

  if (directCommands.has(normalized)) {
    return true;
  }

  return isAddressedToBot(config, normalized) && /(?:stop|cancel|停止|停下|别跟了|别跟着我)/u.test(normalized);
}

function isAddressedToBot(config: WorkerPluginConfig, normalized: string): boolean {
  const botName = config.username.toLowerCase();
  const botId = config.botId.toLowerCase();
  return normalized.includes(botName) || normalized.includes(botId) || normalized.startsWith("bot ") || normalized.startsWith("bp ");
}

function normalizeChatMessage(message: string): string {
  return message.trim().toLowerCase().replace(/[，。！？!?,.]/gu, "").replace(/\s+/gu, " ");
}
