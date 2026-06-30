import { createId, nowIso, type BotAction, type BotCapability, type WorldSnapshot } from "@blockpilot/core";

export type AgentTaskStep =
  | {
      type: "action";
      action: BotAction;
      description?: string;
    }
  | {
      type: "say";
      message: string;
      description?: string;
    }
  | {
      type: "wait";
      durationMs: number;
      description?: string;
    };

export interface AgentTaskDefinition {
  title: string;
  source?: string;
  steps: AgentTaskStep[];
}

export interface AgentTaskSnapshot {
  taskId: string;
  title: string;
  source?: string;
  state: "pending" | "running" | "completed" | "failed" | "cancelled";
  createdAt: string;
  updatedAt: string;
  currentStepIndex: number;
  stepCount: number;
  lastMessage?: string;
}

export interface AgentTaskRunner {
  canRunAction(actionName: string): boolean;
  log(type: string, payload?: Record<string, unknown>): void;
  runAction(action: BotAction): Promise<unknown>;
  say(message: string): Promise<unknown>;
}

interface AgentTask extends AgentTaskSnapshot {
  steps: AgentTaskStep[];
  waitUntil?: number;
}

const MAX_QUEUE_SIZE = 12;
const MAX_TASK_STEPS = 24;

export class AgentTaskQueue {
  private readonly tasks: AgentTask[] = [];

  enqueue(definition: AgentTaskDefinition): AgentTaskSnapshot {
    if (definition.steps.length === 0) {
      throw new Error("Cannot enqueue an empty agent task");
    }

    if (this.tasks.filter((task) => task.state === "pending" || task.state === "running").length >= MAX_QUEUE_SIZE) {
      throw new Error(`Agent task queue is full (${MAX_QUEUE_SIZE})`);
    }

    const now = nowIso();
    const task: AgentTask = {
      taskId: createId("agent_task"),
      title: definition.title.trim() || "Untitled task",
      state: "pending",
      createdAt: now,
      updatedAt: now,
      currentStepIndex: 0,
      stepCount: Math.min(definition.steps.length, MAX_TASK_STEPS),
      steps: definition.steps.slice(0, MAX_TASK_STEPS).map(cloneTaskStep),
    };

    if (definition.source) {
      task.source = definition.source;
    }

    this.tasks.push(task);
    this.pruneFinishedTasks();
    return cloneSnapshot(task);
  }

  cancelActive(reason: string): number {
    let count = 0;
    for (const task of this.tasks) {
      if (task.state !== "pending" && task.state !== "running") {
        continue;
      }

      task.state = "cancelled";
      task.updatedAt = nowIso();
      task.lastMessage = reason;
      count += 1;
    }

    return count;
  }

  snapshots(): AgentTaskSnapshot[] {
    return this.tasks.map((task) => cloneSnapshot(task));
  }

  hasRunnableTask(): boolean {
    return this.tasks.some((task) => task.state === "pending" || task.state === "running");
  }

  async tick(world: WorldSnapshot, runner: AgentTaskRunner): Promise<boolean> {
    const task = this.nextRunnableTask();
    if (!task) {
      return false;
    }

    if (world.currentTask) {
      runner.log("task.paused", {
        task: cloneSnapshot(task),
        reason: "worker_current_task",
        currentTask: world.currentTask,
      });
      return false;
    }

    if (world.safety.dangerLevel === "danger" || world.safety.dangerLevel === "critical") {
      runner.log("task.paused", {
        task: cloneSnapshot(task),
        reason: "unsafe_world",
        dangerLevel: world.safety.dangerLevel,
        threats: world.safety.threats.slice(0, 8),
      });
      return false;
    }

    if (task.waitUntil && Date.now() < task.waitUntil) {
      runner.log("task.waiting", {
        task: cloneSnapshot(task),
        waitRemainingMs: task.waitUntil - Date.now(),
      });
      return false;
    }

    delete task.waitUntil;
    task.state = "running";
    task.updatedAt = nowIso();

    const step = task.steps[task.currentStepIndex];
    if (!step) {
      this.completeTask(task, "Task completed");
      runner.log("task.completed", { task: cloneSnapshot(task) });
      return false;
    }

    runner.log("task.step.execute", {
      task: cloneSnapshot(task),
      step,
    });

    try {
      if (step.type === "wait") {
        task.waitUntil = Date.now() + Math.max(0, step.durationMs);
        task.lastMessage = step.description ?? `Waiting ${step.durationMs}ms`;
        task.currentStepIndex += 1;
        task.updatedAt = nowIso();
        runner.log("task.step.result", {
          task: cloneSnapshot(task),
          step,
          result: {
            waitUntil: new Date(task.waitUntil).toISOString(),
          },
        });
        return true;
      }

      if (step.type === "say") {
        const result = await runner.say(step.message);
        this.finishStep(task, step.description ?? "Said task message");
        runner.log("task.step.result", { task: cloneSnapshot(task), step, result });
        return true;
      }

      if (!runner.canRunAction(step.action.name)) {
        this.failTask(task, `Action '${step.action.name}' is unavailable or not allowed`);
        runner.log("task.step.skipped", {
          task: cloneSnapshot(task),
          step,
          reason: "action_unavailable_or_not_allowed",
        });
        return true;
      }

      const result = await runner.runAction(step.action);
      this.finishStep(task, step.description ?? `Ran ${step.action.name}`);
      runner.log("task.step.result", { task: cloneSnapshot(task), step, result });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.failTask(task, message);
      runner.log("task.step.error", {
        task: cloneSnapshot(task),
        step,
        error: message,
      });
      return true;
    }
  }

  private nextRunnableTask(): AgentTask | undefined {
    return this.tasks.find((task) => task.state === "running") ?? this.tasks.find((task) => task.state === "pending");
  }

  private finishStep(task: AgentTask, message: string): void {
    task.currentStepIndex += 1;
    task.updatedAt = nowIso();
    task.lastMessage = message;

    if (task.currentStepIndex >= task.steps.length) {
      this.completeTask(task, "Task completed");
    }
  }

  private completeTask(task: AgentTask, message: string): void {
    task.state = "completed";
    task.updatedAt = nowIso();
    task.lastMessage = message;
  }

  private failTask(task: AgentTask, message: string): void {
    task.state = "failed";
    task.updatedAt = nowIso();
    task.lastMessage = message;
  }

  private pruneFinishedTasks(): void {
    const active = this.tasks.filter((task) => task.state === "pending" || task.state === "running");
    const finished = this.tasks.filter((task) => task.state !== "pending" && task.state !== "running").slice(-20);
    this.tasks.splice(0, this.tasks.length, ...finished, ...active);
  }
}

export function compactTaskCapabilities(capabilities: BotCapability[]): string[] {
  return capabilities.map((capability) => capability.name).sort();
}

function cloneTaskStep(step: AgentTaskStep): AgentTaskStep {
  if (step.type === "action") {
    const clone: AgentTaskStep = {
      type: "action",
      action: {
        name: step.action.name,
      },
    };
    if (step.action.args) {
      clone.action.args = { ...step.action.args };
    }
    if (step.description) {
      clone.description = step.description;
    }
    return clone;
  }

  if (step.type === "say") {
    const clone: AgentTaskStep = {
      type: "say",
      message: step.message,
    };
    if (step.description) {
      clone.description = step.description;
    }
    return clone;
  }

  const clone: AgentTaskStep = {
    type: "wait",
    durationMs: step.durationMs,
  };
  if (step.description) {
    clone.description = step.description;
  }
  return clone;
}

function cloneSnapshot(task: AgentTask): AgentTaskSnapshot {
  const snapshot: AgentTaskSnapshot = {
    taskId: task.taskId,
    title: task.title,
    state: task.state,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    currentStepIndex: task.currentStepIndex,
    stepCount: task.stepCount,
  };

  if (task.source) {
    snapshot.source = task.source;
  }

  if (task.lastMessage) {
    snapshot.lastMessage = task.lastMessage;
  }

  return snapshot;
}
