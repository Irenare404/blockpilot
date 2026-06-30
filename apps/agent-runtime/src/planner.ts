import type { BotAction, ChatMessageSnapshot, WorldSnapshot } from "@blockpilot/core";
import type { AgentMemorySnapshot } from "./memory-store.js";

export interface PlannerContext {
  botId: string;
  botUsername: string;
  botNames: string[];
  commandPrefix: string;
  allowedActionNames: string[];
  chat: ChatMessageSnapshot;
  world: WorldSnapshot;
  memory?: AgentMemorySnapshot;
}

export type AgentPlanStep =
  | {
      type: "say";
      message: string;
    }
  | {
      type: "action";
      action: BotAction;
    }
  | {
      type: "memory";
      operation: "set_home";
      notes?: string;
    };

export interface AgentPlan {
  addressedToBot: boolean;
  confidence?: number;
  reason?: string;
  steps: AgentPlanStep[];
}

export interface AgentPlanner {
  plan(context: PlannerContext): Promise<AgentPlan>;
}

export function ignorePlan(reason?: string): AgentPlan {
  return reason
    ? {
        addressedToBot: false,
        reason,
        steps: [],
      }
    : {
        addressedToBot: false,
        steps: [],
      };
}
