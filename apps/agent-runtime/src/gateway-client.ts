import type {
  ActionResult,
  BotAction,
  BotCapability,
  BotTaskSnapshot,
  JsonRecord,
  WorkerResultMessage,
  WorldSnapshot,
} from "@blockpilot/core";
import { isRecord, safeJsonParse } from "@blockpilot/core";

export interface TaskListResponse {
  botId: string;
  currentTask?: BotTaskSnapshot;
  recentTasks: BotTaskSnapshot[];
}

export interface ActionListResponse {
  botId: string;
  actions: BotCapability[];
}

export class GatewayActionError extends Error {
  readonly action: BotAction;
  readonly status: number;
  readonly workerResult?: WorkerResultMessage;

  constructor(action: BotAction, status: number, message: string, workerResult?: WorkerResultMessage) {
    super(`Action '${action.name}' failed: ${message}`);
    this.name = "GatewayActionError";
    this.action = action;
    this.status = status;
    if (workerResult) {
      this.workerResult = workerResult;
    }
  }
}

export class GatewayClient {
  private readonly baseUrl: string;
  private readonly botId: string;

  constructor(baseUrl: string, botId: string) {
    this.baseUrl = baseUrl.replace(/\/+$/u, "");
    this.botId = botId;
  }

  async getActions(): Promise<ActionListResponse> {
    return this.fetchJson<ActionListResponse>(`/bots/${encodeURIComponent(this.botId)}/actions`);
  }

  async getTasks(): Promise<TaskListResponse> {
    return this.fetchJson<TaskListResponse>(`/bots/${encodeURIComponent(this.botId)}/tasks`);
  }

  async getWorld(): Promise<WorldSnapshot> {
    return this.fetchJson<WorldSnapshot>(`/bots/${encodeURIComponent(this.botId)}/world`);
  }

  async runAction(action: BotAction): Promise<WorkerResultMessage> {
    const response = await fetch(`${this.baseUrl}/bots/${encodeURIComponent(this.botId)}/actions`, {
      body: JSON.stringify(action),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    });
    const text = await response.text();
    const parsed = safeJsonParse(text);
    const workerResult = parseWorkerResult(parsed);

    if (!response.ok) {
      throw new GatewayActionError(action, response.status, workerResult?.error ?? text, workerResult);
    }

    if (workerResult && workerResult.ok === false) {
      throw new GatewayActionError(action, response.status, workerResult.error ?? "worker returned ok=false", workerResult);
    }

    if (!workerResult) {
      throw new GatewayActionError(action, response.status, `Invalid worker result: ${text}`);
    }

    return workerResult;
  }

  async chat(message: string): Promise<ActionResult | undefined> {
    const response = await this.runAction({
      name: "chat",
      args: {
        message,
      },
    });
    return response.result;
  }

  private async fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, init);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Gateway request failed ${response.status}: ${text}`);
    }

    return (await response.json()) as T;
  }
}

function parseWorkerResult(value: unknown): WorkerResultMessage | undefined {
  if (
    !isRecord(value) ||
    value.type !== "worker.result" ||
    typeof value.requestId !== "string" ||
    typeof value.ok !== "boolean"
  ) {
    return undefined;
  }

  const message: WorkerResultMessage = {
    type: "worker.result",
    requestId: value.requestId,
    ok: value.ok,
  };

  const result = parseActionResult(value.result);
  if (result) {
    message.result = result;
  }

  if (typeof value.error === "string") {
    message.error = value.error;
  }

  return message;
}

function parseActionResult(value: unknown): ActionResult | undefined {
  if (!isRecord(value) || typeof value.ok !== "boolean") {
    return undefined;
  }

  const result: ActionResult = {
    ok: value.ok,
  };

  if (typeof value.message === "string") {
    result.message = value.message;
  }

  if (isRecord(value.data)) {
    result.data = value.data as JsonRecord;
  }

  return result;
}
