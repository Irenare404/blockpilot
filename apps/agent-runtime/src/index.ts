import { asErrorMessage } from "@blockpilot/core";
import { GatewayClient } from "./gateway-client.js";
import { RuleAgent } from "./rule-agent.js";

interface AgentConfig {
  botId: string;
  commandPrefix: string;
  gatewayHttpUrl: string;
  tickIntervalMs: number;
}

const config = readConfig();
const client = new GatewayClient(config.gatewayHttpUrl, config.botId);
const agent = new RuleAgent(client, {
  botId: config.botId,
  commandPrefix: config.commandPrefix,
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
console.log(`[agent-runtime] command prefix: ${config.commandPrefix}`);

while (!shuttingDown) {
  try {
    await agent.tick();
  } catch (error) {
    console.warn(`[agent-runtime] tick failed: ${asErrorMessage(error)}`);
  }

  await sleep(config.tickIntervalMs);
}

console.log("[agent-runtime] stopped");

function readConfig(): AgentConfig {
  return {
    botId: process.env.BLOCKPILOT_BOT_ID ?? "BlockPilot",
    commandPrefix: readNonEmptyString(process.env.BLOCKPILOT_AGENT_PREFIX, "!bp"),
    gatewayHttpUrl: process.env.BLOCKPILOT_GATEWAY_HTTP ?? "http://127.0.0.1:8787",
    tickIntervalMs: readInteger(process.env.BLOCKPILOT_AGENT_TICK_MS, 2_000),
  };
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
