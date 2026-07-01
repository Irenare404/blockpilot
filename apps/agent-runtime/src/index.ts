import { asErrorMessage } from "@blockpilot/core";
import { loadDotEnv } from "@blockpilot/node-env";
import { AutonomyLoop } from "./autonomy.js";
import { ChatAgent } from "./chat-agent.js";
import { createDefaultDecisionLogPath, DecisionLogger, readDecisionLogMode, type DecisionLogMode } from "./decision-log.js";
import { GatewayClient } from "./gateway-client.js";
import { LlmPlanner } from "./llm-planner.js";
import { createDefaultMemoryPath, MemoryStore, readAutonomyMode, type AutonomyMode } from "./memory-store.js";
import type { AgentPlanner } from "./planner.js";
import { RulePlanner } from "./rule-planner.js";
import { SafetyReflex } from "./safety-reflex.js";
import { AgentTaskQueue } from "./task-queue.js";

type PlannerKind = "llm" | "rule";

loadDotEnv();

interface AgentConfig {
  botId: string;
  commandPrefix: string;
  gatewayHttpUrl: string;
  tickIntervalMs: number;
  plannerKind: PlannerKind;
  aliases: string[];
  allowedActionNames: string[];
  responseDedupMs: number;
  decisionLog: {
    mode: DecisionLogMode;
    filePath: string;
  };
  memoryFilePath: string;
  autonomy: {
    enabled: boolean;
    mode: AutonomyMode;
    intervalMs: number;
    chatEnabled: boolean;
    requireRecentChat: boolean;
    recentChatWindowMs: number;
    startupGraceMs: number;
  };
  safetyReflex: {
    enabled: boolean;
    cooldownMs: number;
    noticeEnabled: boolean;
    noticeCooldownMs: number;
  };
  llm?: {
    baseUrl: string;
    apiKey: string;
    model: string;
    temperature: number;
    timeoutMs: number;
  };
}

const config = readConfig();
const client = new GatewayClient(config.gatewayHttpUrl, config.botId);
const planner = createPlanner(config);
const decisionLogger = new DecisionLogger(config.decisionLog);
const taskQueue = new AgentTaskQueue();
const memory = new MemoryStore(config.memoryFilePath, config.botId, config.autonomy.mode);
await memory.load();
const safety = new SafetyReflex(client, {
  enabled: config.safetyReflex.enabled,
  cooldownMs: config.safetyReflex.cooldownMs,
  noticeEnabled: config.safetyReflex.noticeEnabled,
  noticeCooldownMs: config.safetyReflex.noticeCooldownMs,
  allowedActionNames: config.allowedActionNames,
});
const autonomy = new AutonomyLoop(client, memory, {
  enabled: config.autonomy.enabled,
  mode: config.autonomy.mode,
  intervalMs: config.autonomy.intervalMs,
  chatEnabled: config.autonomy.chatEnabled,
  requireRecentChat: config.autonomy.requireRecentChat,
  recentChatWindowMs: config.autonomy.recentChatWindowMs,
  startupGraceMs: config.autonomy.startupGraceMs,
  allowedActionNames: config.allowedActionNames,
});
const agent = new ChatAgent(client, planner, {
  botId: config.botId,
  commandPrefix: config.commandPrefix,
  aliases: config.aliases,
  allowedActionNames: config.allowedActionNames,
  responseDedupMs: config.responseDedupMs,
  memory,
  safety,
  autonomy,
  decisionLogger,
  taskQueue,
});

let shuttingDown = false;

process.once("SIGINT", () => {
  shuttingDown = true;
});

process.once("SIGTERM", () => {
  shuttingDown = true;
});

console.log(`[agent-runtime] starting for bot '${config.botId}'`);
console.log(`[agent-runtime] gateway: ${config.gatewayHttpUrl}`);
console.log(`[agent-runtime] planner: ${config.plannerKind}`);
console.log(`[agent-runtime] command prefix: ${config.commandPrefix}`);
console.log(`[agent-runtime] aliases: ${config.aliases.join(", ") || "none"}`);
console.log(`[agent-runtime] allowed actions: ${config.allowedActionNames.join(", ")}`);
console.log(`[agent-runtime] safety reflex: ${config.safetyReflex.enabled ? "enabled" : "disabled"}`);
console.log(`[agent-runtime] memory: ${config.memoryFilePath}`);
console.log(
  `[agent-runtime] autonomy: ${config.autonomy.enabled ? "enabled" : "disabled"} (${config.autonomy.mode}, interval ${config.autonomy.intervalMs}ms)`,
);
console.log(
  `[agent-runtime] autonomy chat gate: ${config.autonomy.requireRecentChat ? `recent chat within ${config.autonomy.recentChatWindowMs}ms` : "off"}, startup grace ${config.autonomy.startupGraceMs}ms`,
);
console.log(
  `[agent-runtime] decision log: ${config.decisionLog.mode}${config.decisionLog.mode === "file" || config.decisionLog.mode === "both" ? ` (${config.decisionLog.filePath})` : ""}`,
);

while (!shuttingDown) {
  try {
    await agent.tick();
  } catch (error) {
    const message = asErrorMessage(error);
    decisionLogger.log("tick.error", { error: message });
    console.warn(`[agent-runtime] tick failed: ${message}`);
  }

  await sleep(config.tickIntervalMs);
}

console.log("[agent-runtime] stopped");

function createPlanner(config: AgentConfig): AgentPlanner {
  if (config.plannerKind === "llm") {
    if (!config.llm) {
      throw new Error("LLM planner selected but LLM config was not created");
    }

    return new LlmPlanner(config.llm);
  }

  return new RulePlanner();
}

function readConfig(): AgentConfig {
  const plannerKind = readPlannerKind(process.env.BLOCKPILOT_AGENT_PLANNER);
  const botId = readNonEmptyString(process.env.BLOCKPILOT_BOT_ID, "BlockPilot");
  const autonomyMode = readAutonomyMode(process.env.BLOCKPILOT_AUTONOMY_MODE, "companion");
  const config: AgentConfig = {
    botId,
    commandPrefix: readNonEmptyString(process.env.BLOCKPILOT_AGENT_PREFIX, "!bp"),
    gatewayHttpUrl: readNonEmptyString(process.env.BLOCKPILOT_GATEWAY_HTTP, "http://127.0.0.1:8787"),
    tickIntervalMs: readInteger(process.env.BLOCKPILOT_AGENT_TICK_MS, 2_000),
    plannerKind,
    aliases: readCsv(process.env.BLOCKPILOT_AGENT_ALIASES),
    allowedActionNames: readCsv(
      process.env.BLOCKPILOT_AGENT_ALLOWED_ACTIONS,
      "chat,follow_player,go_to_position,dig_nearest_block,place_block,use_nearest_block,inspect_nearest_container,collect_nearest_item,drop_item,attack_nearest_entity,stop,report_position,world_snapshot,eat_food,retreat_from_threat",
    ),
    responseDedupMs: readInteger(process.env.BLOCKPILOT_RESPONSE_DEDUP_MS, 30_000),
    decisionLog: {
      mode: readDecisionLogMode(process.env.BLOCKPILOT_AGENT_DECISION_LOG, "off"),
      filePath: readNonEmptyString(process.env.BLOCKPILOT_AGENT_DECISION_LOG_FILE, createDefaultDecisionLogPath(botId)),
    },
    memoryFilePath: readNonEmptyString(process.env.BLOCKPILOT_MEMORY_FILE, createDefaultMemoryPath(botId)),
    autonomy: {
      enabled: readBoolean(process.env.BLOCKPILOT_AUTONOMY, false),
      mode: autonomyMode,
      intervalMs: readInteger(process.env.BLOCKPILOT_AUTONOMY_INTERVAL_MS, 120_000),
      chatEnabled: readBoolean(process.env.BLOCKPILOT_AUTONOMY_CHAT, true),
      requireRecentChat: readBoolean(process.env.BLOCKPILOT_AUTONOMY_REQUIRE_RECENT_CHAT, true),
      recentChatWindowMs: readInteger(process.env.BLOCKPILOT_AUTONOMY_RECENT_CHAT_WINDOW_MS, 180_000),
      startupGraceMs: readNonNegativeInteger(process.env.BLOCKPILOT_AUTONOMY_STARTUP_GRACE_MS, 120_000),
    },
    safetyReflex: {
      enabled: readBoolean(process.env.BLOCKPILOT_SAFETY_REFLEX, true),
      cooldownMs: readInteger(process.env.BLOCKPILOT_SAFETY_COOLDOWN_MS, 5_000),
      noticeEnabled: readBoolean(process.env.BLOCKPILOT_SAFETY_NOTICE, false),
      noticeCooldownMs: readInteger(process.env.BLOCKPILOT_SAFETY_NOTICE_COOLDOWN_MS, 15_000),
    },
  };

  if (plannerKind === "llm") {
    config.llm = readLlmConfig();
  }

  return config;
}

function readLlmConfig(): NonNullable<AgentConfig["llm"]> {
  const apiKey = process.env.BLOCKPILOT_LLM_API_KEY ?? process.env.OPENAI_API_KEY;
  const model = process.env.BLOCKPILOT_LLM_MODEL;

  if (!apiKey) {
    throw new Error("BLOCKPILOT_AGENT_PLANNER=llm requires BLOCKPILOT_LLM_API_KEY or OPENAI_API_KEY");
  }

  if (!model) {
    throw new Error("BLOCKPILOT_AGENT_PLANNER=llm requires BLOCKPILOT_LLM_MODEL");
  }

  return {
    baseUrl: readNonEmptyString(process.env.BLOCKPILOT_LLM_BASE_URL, "https://api.openai.com/v1"),
    apiKey,
    model,
    temperature: readNumber(process.env.BLOCKPILOT_LLM_TEMPERATURE, 0.2),
    timeoutMs: readInteger(process.env.BLOCKPILOT_LLM_TIMEOUT_MS, 15_000),
  };
}

function readPlannerKind(value: string | undefined): PlannerKind {
  const normalized = value?.trim().toLowerCase();
  return normalized === "llm" ? "llm" : "rule";
}

function readCsv(value: string | undefined, fallback = ""): string[] {
  return (value ?? fallback)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readNonEmptyString(value: string | undefined, fallback: string): string {
  const normalized = value?.trim();
  return normalized ? normalized : fallback;
}

function readInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readNonNegativeInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function readNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
