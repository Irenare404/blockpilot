import type { BotAction, ChatMessageSnapshot, WorldSnapshot } from "@blockpilot/core";

export interface PlannerContext {
  botId: string;
  botUsername: string;
  botNames: string[];
  commandPrefix: string;
  allowedActionNames: string[];
  chat: ChatMessageSnapshot;
  world: WorldSnapshot;
}

export type AgentPlanStep =
  | {
      type: "say";
      message: string;
    }
  | {
      type: "action";
      action: BotAction;
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
