import { isRecord, type ActionResult, type BotAction, type BotCapability, type JsonRecord, type JsonValue, type WorldSnapshot } from "@blockpilot/core";
import type { Bot } from "mineflayer";

export interface ChatEvent {
  username: string;
  message: string;
}

export interface WorkerPluginConfig {
  botId: string;
  username: string;
}

export interface WorkerMinecraftApi {
  chat: (message: string) => void;
  followPlayer: (playerName: string, distance?: number) => Promise<ActionResult>;
  goToPosition: (x: number, y: number, z: number, range?: number) => Promise<ActionResult>;
  requireBot: () => Bot;
  stopCurrentControls: (reason?: string) => void;
}

export interface WorkerPluginContext {
  actions: {
    execute: (action: BotAction) => Promise<ActionResult>;
    list: () => BotCapability[];
    register: (capability: BotCapability, handler: ActionHandler) => void;
  };
  config: WorkerPluginConfig;
  emitEvent: (kind: string, message?: string, payload?: JsonRecord) => void;
  events: {
    onChat: (handler: ChatEventHandler) => void;
  };
  logger: {
    error: (message: string) => void;
    info: (message: string) => void;
    warn: (message: string) => void;
  };
  minecraft: WorkerMinecraftApi;
  world: {
    getSnapshot: () => WorldSnapshot;
  };
}

export interface WorkerPlugin {
  id: string;
  name?: string;
  setup: (ctx: WorkerPluginContext) => void | Promise<void>;
}

export type ActionHandler = (action: BotAction) => Promise<ActionResult> | ActionResult;
export type ChatEventHandler = (event: ChatEvent) => void | Promise<void>;

interface RegisteredAction {
  capability: BotCapability;
  handler: ActionHandler;
  pluginId: string;
}

interface PluginRuntimeOptions {
  config: WorkerPluginConfig;
  emitEvent: WorkerPluginContext["emitEvent"];
  logger: WorkerPluginContext["logger"];
  minecraft: WorkerMinecraftApi;
  world: WorkerPluginContext["world"];
}

export class PluginRuntime {
  private readonly actionRegistry = new Map<string, RegisteredAction>();
  private readonly chatHandlers = new Map<string, ChatEventHandler[]>();
  private readonly loadedPluginIds = new Set<string>();
  private readonly options: PluginRuntimeOptions;

  constructor(options: PluginRuntimeOptions) {
    this.options = options;
  }

  async load(plugins: WorkerPlugin[]): Promise<void> {
    for (const plugin of plugins) {
      await this.loadOne(plugin);
    }
  }

  listCapabilities(): BotCapability[] {
    return [...this.actionRegistry.values()].map((registered) => registered.capability);
  }

  async execute(action: BotAction): Promise<ActionResult> {
    const registered = this.actionRegistry.get(action.name);
    if (!registered) {
      throw new Error(`Unknown action '${action.name}'`);
    }

    return registered.handler(action);
  }

  async emitChat(event: ChatEvent): Promise<void> {
    for (const [pluginId, handlers] of this.chatHandlers) {
      for (const handler of handlers) {
        try {
          await handler(event);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.options.logger.warn(`[plugin:${pluginId}] chat handler failed: ${message}`);
          this.options.emitEvent("plugin.error", message, {
            pluginId,
            phase: "chat",
          });
        }
      }
    }
  }

  private async loadOne(plugin: WorkerPlugin): Promise<void> {
    if (this.loadedPluginIds.has(plugin.id)) {
      throw new Error(`Plugin '${plugin.id}' is already loaded`);
    }

    const ctx = this.createContext(plugin.id);
    await plugin.setup(ctx);
    this.loadedPluginIds.add(plugin.id);
    this.options.logger.info(`[plugin:${plugin.id}] loaded`);
  }

  private createContext(pluginId: string): WorkerPluginContext {
    return {
      actions: {
        execute: (action) => this.execute(action),
        list: () => this.listCapabilities(),
        register: (capability, handler) => {
          this.registerAction(pluginId, capability, handler);
        },
      },
      config: this.options.config,
      emitEvent: this.options.emitEvent,
      events: {
        onChat: (handler) => {
          const handlers = this.chatHandlers.get(pluginId) ?? [];
          handlers.push(handler);
          this.chatHandlers.set(pluginId, handlers);
        },
      },
      logger: this.options.logger,
      minecraft: this.options.minecraft,
      world: this.options.world,
    };
  }

  private registerAction(pluginId: string, capability: BotCapability, handler: ActionHandler): void {
    const actionName = capability.name.trim();
    if (!actionName) {
      throw new Error(`Plugin '${pluginId}' tried to register an empty action name`);
    }

    if (this.actionRegistry.has(actionName)) {
      throw new Error(`Action '${actionName}' is already registered`);
    }

    this.actionRegistry.set(actionName, {
      capability: {
        ...capability,
        name: actionName,
      },
      handler,
      pluginId,
    });

    this.options.logger.info(`[plugin:${pluginId}] registered action '${actionName}'`);
  }
}

export function getArgs(action: BotAction): JsonRecord {
  return action.args ?? {};
}

export function getOptionalNumberArg(action: BotAction, key: string): number | undefined {
  const value = getArgs(action)[key];
  return typeof value === "number" ? value : undefined;
}

export function getOptionalBooleanArg(action: BotAction, key: string): boolean | undefined {
  const value = getArgs(action)[key];
  return typeof value === "boolean" ? value : undefined;
}

export function getOptionalStringArg(action: BotAction, key: string): string | undefined {
  const value = getArgs(action)[key];
  return typeof value === "string" ? value : undefined;
}

export function requireStringArg(action: BotAction, key: string): string {
  const value = getOptionalStringArg(action, key);
  if (!value || value.trim().length === 0) {
    throw new Error(`Action '${action.name}' requires string argument '${key}'`);
  }

  return value;
}

export function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => toJsonValue(item));
  }

  if (isRecord(value)) {
    const record: JsonRecord = {};
    for (const [key, item] of Object.entries(value)) {
      record[key] = toJsonValue(item);
    }
    return record;
  }

  return String(value);
}
