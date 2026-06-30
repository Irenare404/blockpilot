import { nowIso } from "@blockpilot/core";
import { mkdir, appendFile } from "node:fs/promises";
import path from "node:path";

export type DecisionLogMode = "off" | "console" | "file" | "both";

export interface DecisionLoggerConfig {
  mode: DecisionLogMode;
  filePath: string;
}

export interface AgentDecisionLogger {
  log(type: string, payload?: Record<string, unknown>): void;
}

export class DecisionLogger implements AgentDecisionLogger {
  private readonly config: DecisionLoggerConfig;

  constructor(config: DecisionLoggerConfig) {
    this.config = {
      ...config,
      filePath: path.resolve(config.filePath),
    };
  }

  log(type: string, payload: Record<string, unknown> = {}): void {
    if (this.config.mode === "off") {
      return;
    }

    const record = sanitize({
      at: nowIso(),
      type,
      ...payload,
    });
    const line = JSON.stringify(record);

    if (this.config.mode === "console" || this.config.mode === "both") {
      console.log(`[agent-decision] ${line}`);
    }

    if (this.config.mode === "file" || this.config.mode === "both") {
      void this.append(line).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[agent-runtime] failed to write decision log: ${message}`);
      });
    }
  }

  private async append(line: string): Promise<void> {
    await mkdir(path.dirname(this.config.filePath), { recursive: true });
    await appendFile(this.config.filePath, `${line}\n`, "utf8");
  }
}

export function createDefaultDecisionLogPath(botId: string, cwd = process.cwd()): string {
  return path.resolve(cwd, ".blockpilot", "logs", `${safeFileName(botId)}-decisions.jsonl`);
}

export function readDecisionLogMode(value: string | undefined, fallback: DecisionLogMode): DecisionLogMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return "console";
  }

  if (normalized === "off" || normalized === "console" || normalized === "file" || normalized === "both") {
    return normalized;
  }

  return fallback;
}

function sanitize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item));
  }

  if (typeof value === "object" && value !== null) {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) {
        output[key] = sanitize(item);
      }
    }
    return output;
  }

  return String(value);
}

function safeFileName(value: string): string {
  return value.replace(/[^a-z0-9._-]+/giu, "_").replace(/^_+|_+$/gu, "") || "agent";
}
