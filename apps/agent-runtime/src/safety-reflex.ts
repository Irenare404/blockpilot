import type { BotAction, DangerLevel, SafetyThreatSnapshot, WorldSnapshot } from "@blockpilot/core";
import type { GatewayClient } from "./gateway-client.js";

export interface SafetyReflexConfig {
  enabled: boolean;
  cooldownMs: number;
  noticeCooldownMs: number;
  allowedActionNames: string[];
}

interface SafetyReaction {
  action: BotAction;
  notice?: string;
}

const FOOD_ITEM_NAMES = new Set([
  "apple",
  "baked_potato",
  "bread",
  "carrot",
  "cooked_beef",
  "cooked_chicken",
  "cooked_cod",
  "cooked_mutton",
  "cooked_porkchop",
  "cooked_rabbit",
  "cooked_salmon",
  "golden_apple",
  "melon_slice",
  "mushroom_stew",
  "pumpkin_pie",
  "rabbit_stew",
  "sweet_berries",
]);

export class SafetyReflex {
  private readonly client: GatewayClient;
  private readonly config: SafetyReflexConfig;
  private lastActionAt = 0;
  private lastNoticeAt = 0;

  constructor(client: GatewayClient, config: SafetyReflexConfig) {
    this.client = client;
    this.config = config;
  }

  async handle(world: WorldSnapshot): Promise<boolean> {
    if (!this.config.enabled) {
      return false;
    }

    const reaction = this.chooseReaction(world);
    if (!reaction) {
      return false;
    }

    const now = Date.now();
    if (now - this.lastActionAt < this.config.cooldownMs) {
      return false;
    }

    this.lastActionAt = now;
    await this.client.runAction(reaction.action);

    if (reaction.notice && this.canRun(world, "chat") && now - this.lastNoticeAt >= this.config.noticeCooldownMs) {
      this.lastNoticeAt = now;
      await this.client.chat(reaction.notice);
    }

    return true;
  }

  private chooseReaction(world: WorldSnapshot): SafetyReaction | undefined {
    if (shouldEat(world) && this.canRun(world, "eat_food") && hasFood(world)) {
      return {
        action: {
          name: "eat_food",
          args: {
            reason: "Safety reflex: health or food is low",
          },
        },
        notice: "I need a second to eat.",
      };
    }

    const immediateThreat = findImmediateThreat(world);
    if (immediateThreat && this.canRun(world, "retreat_from_threat")) {
      return {
        action: createRetreatAction(immediateThreat),
        notice: `I am backing away from ${immediateThreat.name}.`,
      };
    }

    if (isDangerous(world.safety.dangerLevel) && this.canRun(world, "stop")) {
      return {
        action: {
          name: "stop",
          args: {
            reason: `Safety reflex: ${world.safety.reasons[0] ?? "danger detected"}`,
          },
        },
        notice: "I stopped because something looks unsafe.",
      };
    }

    return undefined;
  }

  private canRun(world: WorldSnapshot, actionName: string): boolean {
    return (
      this.config.allowedActionNames.includes(actionName) &&
      world.capabilities.some((capability) => capability.name === actionName)
    );
  }
}

function shouldEat(world: WorldSnapshot): boolean {
  const health = world.self.health ?? world.status.health;
  const food = world.self.food ?? world.status.food;
  return (typeof health === "number" && health <= 10) || (typeof food === "number" && food <= 8);
}

function hasFood(world: WorldSnapshot): boolean {
  return [world.self.heldItem, ...world.self.inventory].some((item) => Boolean(item && FOOD_ITEM_NAMES.has(item.name)));
}

function findImmediateThreat(world: WorldSnapshot): SafetyThreatSnapshot | undefined {
  return world.safety.threats
    .filter((threat) => isDangerous(threat.severity))
    .filter((threat) => threat.trapped !== true)
    .filter((threat) => threat.kind !== "entity" || threat.canReachBot !== false)
    .filter((threat) => Boolean(threat.position))
    .sort((a, b) => compareDangerLevel(b.severity, a.severity) || (a.distance ?? 999) - (b.distance ?? 999))[0];
}

function createRetreatAction(threat: SafetyThreatSnapshot): BotAction {
  const args: NonNullable<BotAction["args"]> = {
    durationMs: threat.severity === "critical" ? 1_600 : 1_000,
    jump: threat.kind === "entity",
    reason: `Safety reflex: ${threat.reason}`,
  };

  if (threat.position) {
    args.threatX = threat.position.x;
    args.threatY = threat.position.y;
    args.threatZ = threat.position.z;
  }

  return {
    name: "retreat_from_threat",
    args,
  };
}

function isDangerous(level: DangerLevel): boolean {
  return level === "danger" || level === "critical";
}

function compareDangerLevel(left: DangerLevel, right: DangerLevel): number {
  return dangerRank(left) - dangerRank(right);
}

function dangerRank(level: DangerLevel): number {
  switch (level) {
    case "safe":
      return 0;
    case "watch":
      return 1;
    case "danger":
      return 2;
    case "critical":
      return 3;
  }
}
