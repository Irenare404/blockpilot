import type { BotCapability, ChatMessageSnapshot, WorldSnapshot } from "@blockpilot/core";
import { ignorePlan, type AgentPlan, type AgentPlanner, type PlannerContext } from "./planner.js";

type AgentCommand =
  | {
      name: "follow";
      chat: ChatMessageSnapshot;
    }
  | {
      name: "dig";
      chat: ChatMessageSnapshot;
      blockName: string;
    }
  | {
      name: "go_home" | "help" | "home" | "memory" | "set_home" | "status" | "stop" | "where" | "world";
      chat: ChatMessageSnapshot;
    };

const HELP_ALIASES = new Set(["", "help", "?", "\u5E2E\u52A9"]);
const STATUS_ALIASES = new Set(["status", "\u72B6\u6001", "\u4EFB\u52A1"]);
const WHERE_ALIASES = new Set([
  "where",
  "position",
  "pos",
  "\u5750\u6807",
  "\u5728\u54EA",
  "\u4F60\u5728\u54EA",
]);
const WORLD_ALIASES = new Set(["world", "\u9644\u8FD1", "\u73A9\u5BB6"]);
const HOME_ALIASES = new Set(["home", "base", "\u5BB6", "\u57FA\u5730"]);
const MEMORY_ALIASES = new Set(["memory", "mem", "\u8BB0\u5FC6"]);
const SET_HOME_ALIASES = new Set([
  "sethome",
  "set home",
  "remember home",
  "\u8BBE\u5BB6",
  "\u8BBE\u7F6E\u5BB6",
  "\u8BB0\u4F4F\u8FD9\u91CC\u662F\u5BB6",
]);
const GO_HOME_ALIASES = new Set(["go home", "return home", "back home", "\u56DE\u5BB6", "\u56DE\u57FA\u5730"]);
const FOLLOW_ALIASES = new Set([
  "follow",
  "follow me",
  "\u8DDF\u968F",
  "\u8DDF\u7740\u6211",
  "\u8FC7\u6765",
]);
const STOP_ALIASES = new Set(["stop", "cancel", "\u505C\u6B62", "\u505C\u4E0B"]);

export class RulePlanner implements AgentPlanner {
  async plan(context: PlannerContext): Promise<AgentPlan> {
    const command = parseCommand(context.chat, context.commandPrefix);
    if (!command) {
      return ignorePlan("message did not use the command prefix");
    }

    return executeCommand(command, context);
  }
}

function parseCommand(chat: ChatMessageSnapshot, commandPrefix: string): AgentCommand | undefined {
  const message = normalizeSpacing(chat.message);
  const prefix = normalizeSpacing(commandPrefix);

  if (!message.startsWith(prefix)) {
    return undefined;
  }

  const rest = message.slice(prefix.length);
  if (!isCommandBoundary(rest)) {
    return undefined;
  }

  const command = normalizeCommand(rest);

  if (HELP_ALIASES.has(command)) {
    return { name: "help", chat };
  }

  if (STATUS_ALIASES.has(command)) {
    return { name: "status", chat };
  }

  if (WHERE_ALIASES.has(command)) {
    return { name: "where", chat };
  }

  if (WORLD_ALIASES.has(command)) {
    return { name: "world", chat };
  }

  if (HOME_ALIASES.has(command)) {
    return { name: "home", chat };
  }

  if (MEMORY_ALIASES.has(command)) {
    return { name: "memory", chat };
  }

  if (SET_HOME_ALIASES.has(command)) {
    return { name: "set_home", chat };
  }

  if (GO_HOME_ALIASES.has(command)) {
    return { name: "go_home", chat };
  }

  const digBlockName = parseDigBlockName(command);
  if (digBlockName) {
    return { name: "dig", chat, blockName: digBlockName };
  }

  if (FOLLOW_ALIASES.has(command)) {
    return { name: "follow", chat };
  }

  if (STOP_ALIASES.has(command)) {
    return { name: "stop", chat };
  }

  return { name: "help", chat };
}

function executeCommand(command: AgentCommand, context: PlannerContext): AgentPlan {
  const world = context.world;
  switch (command.name) {
    case "help":
      return addressedPlan([{ type: "say", message: createHelpMessage(world.capabilities, context.commandPrefix) }]);
    case "status":
      return addressedPlan([{ type: "say", message: createStatusMessage(world) }]);
    case "where":
      if (hasCapability(world.capabilities, "report_position")) {
        return addressedPlan([{ type: "action", action: { name: "report_position", args: {} } }]);
      }
      return addressedPlan([{ type: "say", message: createPositionMessage(world) }]);
    case "world":
      return addressedPlan([{ type: "say", message: createWorldMessage(world) }]);
    case "home":
      return addressedPlan([{ type: "say", message: createHomeMessage(context) }]);
    case "memory":
      return addressedPlan([{ type: "say", message: createMemoryMessage(context) }]);
    case "set_home":
      return addressedPlan([
        {
          type: "memory",
          operation: "set_home",
          notes: `Set by '${command.chat.username}' through rule command.`,
        },
        { type: "say", message: "Home saved at my current position." },
      ]);
    case "go_home":
      return createGoHomePlan(context);
    case "dig":
      return createDigPlan(command, context);
    case "follow":
      return addressedPlan([
        {
          type: "action",
          action: {
            name: "follow_player",
            args: {
              playerName: command.chat.username,
              distance: 2,
            },
          },
        },
      ]);
    case "stop":
      return addressedPlan([
        {
          type: "action",
          action: {
            name: "stop",
            args: {
              reason: `Agent stop command from '${command.chat.username}'`,
            },
          },
        },
      ]);
  }
}

function addressedPlan(steps: AgentPlan["steps"]): AgentPlan {
  return {
    addressedToBot: true,
    confidence: 1,
    steps,
  };
}

function createHelpMessage(capabilities: BotCapability[], prefix: string): string {
  const names = capabilities.map((capability) => capability.name).sort().join(", ");
  return `Agent commands: ${prefix} help/status/where/world/follow/stop/home/sethome/go home/memory/dig dirt. Tools: ${names || "none"}.`;
}

function createPositionMessage(world: WorldSnapshot): string {
  const position = world.status.position;
  if (!position) {
    return "I do not know my position yet.";
  }

  return `Position: ${position.x}, ${position.y}, ${position.z} (${world.status.dimension ?? "unknown"})`;
}

function createStatusMessage(world: WorldSnapshot): string {
  const health = world.status.health ?? "?";
  const food = world.status.food ?? "?";
  const position = world.status.position
    ? `${world.status.position.x}, ${world.status.position.y}, ${world.status.position.z}`
    : "unknown";
  const task = world.currentTask ? `${world.currentTask.actionName}:${world.currentTask.state}` : "idle";

  return `Status: hp=${health}, food=${food}, pos=${position}, task=${task}.`;
}

function createWorldMessage(world: WorldSnapshot): string {
  if (world.nearbyPlayers.length === 0) {
    return "No nearby visible players.";
  }

  const players = world.nearbyPlayers
    .slice(0, 5)
    .map((player) => `${player.username}${typeof player.distance === "number" ? `(${player.distance})` : ""}`)
    .join(", ");

  return `Nearby: ${players}.`;
}

function createHomeMessage(context: PlannerContext): string {
  const home = context.memory?.home;
  if (!home) {
    return "I do not know home yet. Use !bp sethome when I am standing at home.";
  }

  return `Home: ${formatPosition(home.position)} (${home.dimension ?? "unknown"}).`;
}

function createMemoryMessage(context: PlannerContext): string {
  const memory = context.memory;
  if (!memory) {
    return "Memory is not loaded yet.";
  }

  const home = memory.home ? `home=${formatPosition(memory.home.position)}` : "home=unknown";
  const players = memory.players
    .slice(0, 3)
    .map((player) => player.username)
    .join(", ");
  const places = memory.places
    .slice(0, 3)
    .map((place) => `${place.kind}:${place.name}`)
    .join(", ");

  return `Memory: ${home}; players=${players || "none"}; places=${places || "none"}.`;
}

function createGoHomePlan(context: PlannerContext): AgentPlan {
  const home = context.memory?.home;
  if (!home) {
    return addressedPlan([{ type: "say", message: "I do not know home yet. Use !bp sethome first." }]);
  }

  if (!hasCapability(context.world.capabilities, "go_to_position")) {
    return addressedPlan([{ type: "say", message: `I know home is at ${formatPosition(home.position)}, but navigation is unavailable.` }]);
  }

  return addressedPlan([
    { type: "say", message: `Heading home: ${formatPosition(home.position)}.` },
    {
      type: "action",
      action: {
        name: "go_to_position",
        args: {
          x: home.position.x,
          y: home.position.y,
          z: home.position.z,
          range: 1,
        },
      },
    },
  ]);
}

function createDigPlan(command: Extract<AgentCommand, { name: "dig" }>, context: PlannerContext): AgentPlan {
  if (!hasCapability(context.world.capabilities, "dig_nearest_block")) {
    return addressedPlan([{ type: "say", message: "I understood the dig request, but dig_nearest_block is unavailable." }]);
  }

  return addressedPlan([
    { type: "say", message: `Digging nearby ${command.blockName}.` },
    {
      type: "action",
      action: {
        name: "dig_nearest_block",
        args: {
          blockName: command.blockName,
          maxDistance: 6,
          count: 1,
        },
      },
    },
  ]);
}

function formatPosition(position: { x: number; y: number; z: number }): string {
  return `${position.x}, ${position.y}, ${position.z}`;
}

function hasCapability(capabilities: BotCapability[], actionName: string): boolean {
  return capabilities.some((capability) => capability.name === actionName);
}

function isCommandBoundary(rest: string): boolean {
  return rest.length === 0 || /^[\s\uFF0C\u3002\uFF01\uFF1F,.!?]/u.test(rest);
}

function normalizeCommand(message: string): string {
  return normalizeSpacing(message).replace(/[\uFF0C\u3002\uFF01\uFF1F,.!?]/gu, "").trim();
}

function normalizeSpacing(message: string): string {
  return message.trim().toLowerCase().replace(/\s+/gu, " ");
}

function parseDigBlockName(command: string): string | undefined {
  for (const prefix of ["dig ", "mine ", "\u6316 "]) {
    if (!command.startsWith(prefix)) {
      continue;
    }

    return normalizeRequestedBlockName(command.slice(prefix.length), true);
  }

  return normalizeRequestedBlockName(command, false);
}

function normalizeRequestedBlockName(value: string, allowUnknown: boolean): string | undefined {
  const normalized = normalizeSpacing(value).replace(/^minecraft:/u, "").replace(/\s+/gu, "_");
  switch (normalized) {
    case "\u6316\u6CE5\u571F":
    case "\u6316\u571F":
    case "\u6CE5\u571F":
    case "\u571F":
    case "dirt":
      return "dirt,grass_block";
    case "\u8349\u65B9\u5757":
    case "grass":
    case "grass_block":
      return "grass_block,dirt";
    case "\u77F3\u5934":
    case "stone":
      return "stone";
    default:
      return allowUnknown && normalized ? normalized : undefined;
  }
}
