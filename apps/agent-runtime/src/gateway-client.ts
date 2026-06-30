import type {
  ActionResult,
  BotAction,
  BotCapability,
  BotTaskSnapshot,
  WorkerResultMessage,
  WorldSnapshot,
} from "@blockpilot/core";

export interface TaskListResponse {
  botId: string;
  currentTask?: BotTaskSnapshot;
  recentTasks: BotTaskSnapshot[];
}

export interface ActionListResponse {
  botId: string;
  actions: BotCapability[];
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
    return this.fetchJson<WorkerResultMessage>(`/bots/${encodeURIComponent(this.botId)}/actions`, {
      body: JSON.stringify(action),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    });
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
