import {
  createId,
  isRecord,
  nowIso,
  safeJsonParse,
  type Vec3Like,
  type WorldBlockSnapshot,
  type WorldSnapshot,
} from "@blockpilot/core";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type AutonomyMode = "companion" | "guard" | "explore" | "builder" | "free_roam";
export type MemoryPlaceKind = "home" | "container" | "spawner" | "utility" | "danger" | "visited";

export interface MemoryPlace {
  id: string;
  kind: MemoryPlaceKind;
  name: string;
  position: Vec3Like;
  dimension?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  seenCount: number;
  notes?: string;
}

export interface MemoryPlayer {
  username: string;
  firstSeenAt: string;
  lastSeenAt: string;
  seenCount: number;
  lastPosition?: Vec3Like;
  notes?: string;
}

export interface MemoryObservation {
  id: string;
  createdAt: string;
  kind: "world" | "safety" | "player" | "place" | "autonomy";
  summary: string;
  position?: Vec3Like;
}

export interface MemoryAutonomyState {
  mode: AutonomyMode;
  lastActedAt?: string;
  lastSuggestion?: string;
}

export interface AgentMemory {
  version: 1;
  botId: string;
  createdAt: string;
  updatedAt: string;
  home?: MemoryPlace;
  places: MemoryPlace[];
  players: MemoryPlayer[];
  observations: MemoryObservation[];
  autonomy: MemoryAutonomyState;
}

export interface AgentMemorySnapshot {
  home?: MemoryPlace;
  places: MemoryPlace[];
  players: MemoryPlayer[];
  recentObservations: MemoryObservation[];
  autonomy: MemoryAutonomyState;
}

const MAX_PLACES = 120;
const MAX_PLAYERS = 80;
const MAX_OBSERVATIONS = 120;
const PLACE_REFRESH_MS = 5 * 60 * 1000;
const PLAYER_REFRESH_MS = 30 * 1000;
const OBSERVATION_DEDUP_MS = 5 * 60 * 1000;

export class MemoryStore {
  private readonly filePath: string;
  private readonly botId: string;
  private readonly defaultAutonomyMode: AutonomyMode;
  private memory: AgentMemory;
  private dirty = false;

  constructor(filePath: string, botId: string, defaultAutonomyMode: AutonomyMode) {
    this.filePath = filePath;
    this.botId = botId;
    this.defaultAutonomyMode = defaultAutonomyMode;
    this.memory = createEmptyMemory(botId, defaultAutonomyMode);
  }

  async load(): Promise<void> {
    try {
      const text = await readFile(this.filePath, "utf8");
      const parsed = safeJsonParse(text);
      this.memory = normalizeMemory(parsed, this.botId, this.defaultAutonomyMode);
      this.syncAutonomyMode(this.defaultAutonomyMode);
      if (this.dirty) {
        await this.save();
      }
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        this.dirty = true;
        await this.save();
        return;
      }

      throw error;
    }
  }

  async observeWorld(world: WorldSnapshot): Promise<void> {
    const at = world.updatedAt || nowIso();
    const dimension = world.status.dimension;
    const position = world.status.position;

    if (position) {
      this.upsertVisitedPlace(position, dimension, at);
      if (!this.memory.home && isSafeHomeCandidate(world)) {
        this.setHome(position, dimension, "First safe position observed.");
      }
    }

    for (const player of world.nearbyPlayers.slice(0, 16)) {
      if (player.username.localeCompare(world.status.username ?? this.botId, undefined, { sensitivity: "accent" }) === 0) {
        continue;
      }

      this.upsertPlayer(player.username, player.position, at);
    }

    this.observeBlocks(world.blocks.nearbyContainers.slice(0, 12), "container", dimension, at);
    this.observeBlocks(world.blocks.nearbyUtilityBlocks.slice(0, 12), "utility", dimension, at);
    this.observeBlocks(world.blocks.nearbySpawners.slice(0, 8), "spawner", dimension, at);
    this.observeBlocks(world.blocks.nearbyDangerBlocks.slice(0, 8), "danger", dimension, at);
    this.observeHighlights(world, at);
    this.prune();

    if (this.dirty) {
      await this.save();
    }
  }

  async setHomeFromWorld(world: WorldSnapshot, notes?: string): Promise<boolean> {
    const position = world.status.position;
    if (!position) {
      return false;
    }

    this.setHome(position, world.status.dimension, notes ?? "Set from player request.");
    this.rememberObservation("place", `Home set at ${formatPosition(position)}.`, position, world.updatedAt || nowIso());
    await this.saveIfDirty();
    return true;
  }

  async markAutonomyActed(summary: string, at = nowIso()): Promise<void> {
    this.memory.autonomy.lastActedAt = at;
    this.memory.autonomy.lastSuggestion = summary;
    this.memory.updatedAt = at;
    this.rememberObservation("autonomy", summary, undefined, at);
    this.dirty = true;
    await this.save();
  }

  getSnapshot(): AgentMemorySnapshot {
    const snapshot: AgentMemorySnapshot = {
      places: sortPlaces(this.memory.places.filter((place) => place.kind !== "home")).slice(0, 24).map(clonePlace),
      players: [...this.memory.players]
        .sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt))
        .slice(0, 16)
        .map(clonePlayer),
      recentObservations: [...this.memory.observations]
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
        .slice(-16)
        .map(cloneObservation),
      autonomy: cloneAutonomy(this.memory.autonomy),
    };

    if (this.memory.home) {
      snapshot.home = clonePlace(this.memory.home);
    }

    return snapshot;
  }

  private syncAutonomyMode(mode: AutonomyMode): void {
    if (this.memory.autonomy.mode === mode) {
      return;
    }

    this.memory.autonomy.mode = mode;
    this.memory.updatedAt = nowIso();
    this.dirty = true;
  }

  private observeBlocks(blocks: WorldBlockSnapshot[], kind: MemoryPlaceKind, dimension: string | undefined, at: string): void {
    for (const block of blocks) {
      this.upsertPlace(kind, block.displayName ?? block.name, block.position, dimension, at, block.name);
    }
  }

  private observeHighlights(world: WorldSnapshot, at: string): void {
    const nearestPlayer = world.nearbyPlayers[0];
    if (nearestPlayer) {
      const suffix = typeof nearestPlayer.distance === "number" ? ` at distance ${nearestPlayer.distance}` : "";
      this.rememberObservation("player", `Saw ${nearestPlayer.username}${suffix}.`, nearestPlayer.position, at);
    }

    const nearestContainer = world.blocks.nearbyContainers[0];
    if (nearestContainer) {
      this.rememberObservation("place", `Noticed container ${nearestContainer.displayName ?? nearestContainer.name}.`, nearestContainer.position, at);
    }

    const nearestSpawner = world.blocks.nearbySpawners[0];
    if (nearestSpawner) {
      this.rememberObservation("place", `Noticed spawner ${nearestSpawner.displayName ?? nearestSpawner.name}.`, nearestSpawner.position, at);
    }

    if (world.safety.dangerLevel !== "safe") {
      this.rememberObservation("safety", `Safety ${world.safety.dangerLevel}: ${world.safety.reasons.slice(0, 2).join(" ")}`, world.status.position, at);
    }
  }

  private upsertVisitedPlace(position: Vec3Like, dimension: string | undefined, at: string): void {
    const cellX = Math.floor(position.x / 32);
    const cellZ = Math.floor(position.z / 32);
    const center = {
      x: cellX * 32 + 16,
      y: Math.round(position.y),
      z: cellZ * 32 + 16,
    };
    this.upsertPlace("visited", `Visited area ${cellX},${cellZ}`, center, dimension, at);
  }

  private upsertPlayer(username: string, position: Vec3Like | undefined, at: string): void {
    const existing = this.memory.players.find((player) => player.username.localeCompare(username, undefined, { sensitivity: "accent" }) === 0);
    if (!existing) {
      const player: MemoryPlayer = {
        username,
        firstSeenAt: at,
        lastSeenAt: at,
        seenCount: 1,
      };
      if (position) {
        player.lastPosition = roundVec3(position);
      }
      this.memory.players.push(player);
      this.memory.updatedAt = at;
      this.dirty = true;
      return;
    }

    if (!shouldRefresh(existing.lastSeenAt, at, PLAYER_REFRESH_MS) && (!position || !hasMoved(existing.lastPosition, position, 2))) {
      return;
    }

    existing.lastSeenAt = at;
    existing.seenCount += 1;
    if (position) {
      existing.lastPosition = roundVec3(position);
    }
    this.memory.updatedAt = at;
    this.dirty = true;
  }

  private upsertPlace(
    kind: MemoryPlaceKind,
    name: string,
    position: Vec3Like,
    dimension: string | undefined,
    at: string,
    notes?: string,
  ): void {
    const id = createPlaceId(kind, name, position, dimension);
    const existing = this.memory.places.find((place) => place.id === id);
    if (!existing) {
      const place: MemoryPlace = {
        id,
        kind,
        name,
        position: roundVec3(position),
        firstSeenAt: at,
        lastSeenAt: at,
        seenCount: 1,
      };
      if (dimension) {
        place.dimension = dimension;
      }
      if (notes) {
        place.notes = notes;
      }
      this.memory.places.push(place);
      this.memory.updatedAt = at;
      this.dirty = true;
      return;
    }

    if (!shouldRefresh(existing.lastSeenAt, at, PLACE_REFRESH_MS)) {
      return;
    }

    existing.lastSeenAt = at;
    existing.seenCount += 1;
    existing.position = roundVec3(position);
    if (notes) {
      existing.notes = notes;
    }
    this.memory.updatedAt = at;
    this.dirty = true;
  }

  private setHome(position: Vec3Like, dimension: string | undefined, notes?: string): void {
    const at = nowIso();
    const home: MemoryPlace = {
      id: "home",
      kind: "home",
      name: "Home",
      position: roundVec3(position),
      firstSeenAt: this.memory.home?.firstSeenAt ?? at,
      lastSeenAt: at,
      seenCount: (this.memory.home?.seenCount ?? 0) + 1,
    };

    if (dimension) {
      home.dimension = dimension;
    }

    if (notes) {
      home.notes = notes;
    }

    this.memory.home = home;
    const existingIndex = this.memory.places.findIndex((place) => place.id === "home");
    if (existingIndex === -1) {
      this.memory.places.push(home);
    } else {
      this.memory.places[existingIndex] = home;
    }
    this.memory.updatedAt = at;
    this.dirty = true;
  }

  private rememberObservation(
    kind: MemoryObservation["kind"],
    summary: string,
    position: Vec3Like | undefined,
    at: string,
  ): void {
    const duplicate = this.memory.observations.some(
      (observation) =>
        observation.kind === kind &&
        observation.summary === summary &&
        Date.parse(at) - Date.parse(observation.createdAt) < OBSERVATION_DEDUP_MS,
    );
    if (duplicate) {
      return;
    }

    const observation: MemoryObservation = {
      id: createId("mem"),
      createdAt: at,
      kind,
      summary,
    };
    if (position) {
      observation.position = roundVec3(position);
    }
    this.memory.observations.push(observation);
    this.memory.updatedAt = at;
    this.dirty = true;
  }

  private prune(): void {
    this.memory.places = sortPlaces(this.memory.places).slice(0, MAX_PLACES);
    this.memory.players = [...this.memory.players]
      .sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt))
      .slice(0, MAX_PLAYERS);
    this.memory.observations = [...this.memory.observations]
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
      .slice(-MAX_OBSERVATIONS);
  }

  private async saveIfDirty(): Promise<void> {
    if (this.dirty) {
      await this.save();
    }
  }

  private async save(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(this.memory, null, 2)}\n`, "utf8");
    this.dirty = false;
  }
}

export function createDefaultMemoryPath(botId: string, cwd = process.cwd()): string {
  return path.resolve(cwd, ".blockpilot", "memory", `${safeFileName(botId)}.json`);
}

export function readAutonomyMode(value: string | undefined, fallback: AutonomyMode): AutonomyMode {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === "companion" ||
    normalized === "guard" ||
    normalized === "explore" ||
    normalized === "builder" ||
    normalized === "free_roam"
  ) {
    return normalized;
  }

  return fallback;
}

function createEmptyMemory(botId: string, mode: AutonomyMode): AgentMemory {
  const at = nowIso();
  return {
    version: 1,
    botId,
    createdAt: at,
    updatedAt: at,
    places: [],
    players: [],
    observations: [],
    autonomy: {
      mode,
    },
  };
}

function normalizeMemory(value: unknown, botId: string, defaultMode: AutonomyMode): AgentMemory {
  const fallback = createEmptyMemory(botId, defaultMode);
  if (!isRecord(value)) {
    return fallback;
  }

  const memory: AgentMemory = {
    version: 1,
    botId,
    createdAt: readString(value.createdAt) ?? fallback.createdAt,
    updatedAt: readString(value.updatedAt) ?? fallback.updatedAt,
    places: Array.isArray(value.places) ? value.places.map(readPlace).filter(isDefined).slice(0, MAX_PLACES) : [],
    players: Array.isArray(value.players) ? value.players.map(readPlayer).filter(isDefined).slice(0, MAX_PLAYERS) : [],
    observations: Array.isArray(value.observations)
      ? value.observations.map(readObservation).filter(isDefined).slice(-MAX_OBSERVATIONS)
      : [],
    autonomy: readAutonomyState(value.autonomy, defaultMode),
  };

  const home = readPlace(value.home);
  if (home) {
    memory.home = {
      ...home,
      id: "home",
      kind: "home",
      name: "Home",
    };
  } else {
    const homePlace = memory.places.find((place) => place.kind === "home");
    if (homePlace) {
      memory.home = clonePlace(homePlace);
    }
  }

  return memory;
}

function readPlace(value: unknown): MemoryPlace | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const id = readString(value.id);
  const kind = readPlaceKind(value.kind);
  const name = readString(value.name);
  const position = readVec3(value.position);
  const firstSeenAt = readString(value.firstSeenAt);
  const lastSeenAt = readString(value.lastSeenAt);
  const seenCount = readPositiveInteger(value.seenCount);

  if (!id || !kind || !name || !position || !firstSeenAt || !lastSeenAt || seenCount === undefined) {
    return undefined;
  }

  const place: MemoryPlace = {
    id,
    kind,
    name,
    position,
    firstSeenAt,
    lastSeenAt,
    seenCount,
  };
  const dimension = readString(value.dimension);
  if (dimension) {
    place.dimension = dimension;
  }
  const notes = readString(value.notes);
  if (notes) {
    place.notes = notes;
  }
  return place;
}

function readPlayer(value: unknown): MemoryPlayer | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const username = readString(value.username);
  const firstSeenAt = readString(value.firstSeenAt);
  const lastSeenAt = readString(value.lastSeenAt);
  const seenCount = readPositiveInteger(value.seenCount);
  if (!username || !firstSeenAt || !lastSeenAt || seenCount === undefined) {
    return undefined;
  }

  const player: MemoryPlayer = {
    username,
    firstSeenAt,
    lastSeenAt,
    seenCount,
  };
  const position = readVec3(value.lastPosition);
  if (position) {
    player.lastPosition = position;
  }
  const notes = readString(value.notes);
  if (notes) {
    player.notes = notes;
  }
  return player;
}

function readObservation(value: unknown): MemoryObservation | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const id = readString(value.id);
  const createdAt = readString(value.createdAt);
  const kind = readObservationKind(value.kind);
  const summary = readString(value.summary);
  if (!id || !createdAt || !kind || !summary) {
    return undefined;
  }

  const observation: MemoryObservation = {
    id,
    createdAt,
    kind,
    summary,
  };
  const position = readVec3(value.position);
  if (position) {
    observation.position = position;
  }
  return observation;
}

function readAutonomyState(value: unknown, defaultMode: AutonomyMode): MemoryAutonomyState {
  if (!isRecord(value)) {
    return {
      mode: defaultMode,
    };
  }

  const autonomy: MemoryAutonomyState = {
    mode: readAutonomyMode(readString(value.mode), defaultMode),
  };
  const lastActedAt = readString(value.lastActedAt);
  if (lastActedAt) {
    autonomy.lastActedAt = lastActedAt;
  }
  const lastSuggestion = readString(value.lastSuggestion);
  if (lastSuggestion) {
    autonomy.lastSuggestion = lastSuggestion;
  }
  return autonomy;
}

function readPlaceKind(value: unknown): MemoryPlaceKind | undefined {
  if (
    value === "home" ||
    value === "container" ||
    value === "spawner" ||
    value === "utility" ||
    value === "danger" ||
    value === "visited"
  ) {
    return value;
  }

  return undefined;
}

function readObservationKind(value: unknown): MemoryObservation["kind"] | undefined {
  if (value === "world" || value === "safety" || value === "player" || value === "place" || value === "autonomy") {
    return value;
  }

  return undefined;
}

function readVec3(value: unknown): Vec3Like | undefined {
  if (
    !isRecord(value) ||
    typeof value.x !== "number" ||
    !Number.isFinite(value.x) ||
    typeof value.y !== "number" ||
    !Number.isFinite(value.y) ||
    typeof value.z !== "number" ||
    !Number.isFinite(value.z)
  ) {
    return undefined;
  }

  return roundVec3({
    x: value.x,
    y: value.y,
    z: value.z,
  });
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isSafeHomeCandidate(world: WorldSnapshot): boolean {
  return world.status.state === "online" && (world.safety.dangerLevel === "safe" || world.safety.dangerLevel === "watch");
}

function shouldRefresh(lastSeenAt: string, now: string, intervalMs: number): boolean {
  return Date.parse(now) - Date.parse(lastSeenAt) >= intervalMs;
}

function hasMoved(previous: Vec3Like | undefined, next: Vec3Like, threshold: number): boolean {
  if (!previous) {
    return true;
  }

  return distanceBetween(previous, next) >= threshold;
}

function createPlaceId(kind: MemoryPlaceKind, name: string, position: Vec3Like, dimension: string | undefined): string {
  const rounded = roundVec3(position);
  return `${kind}:${dimension ?? "unknown"}:${safeFileName(name)}:${Math.round(rounded.x)}:${Math.round(rounded.y)}:${Math.round(rounded.z)}`;
}

function sortPlaces(places: MemoryPlace[]): MemoryPlace[] {
  return [...places].sort((a, b) => {
    const rankDiff = placeRank(b) - placeRank(a);
    if (rankDiff !== 0) {
      return rankDiff;
    }

    return Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt);
  });
}

function placeRank(place: MemoryPlace): number {
  const kindRank = {
    home: 1000,
    spawner: 800,
    container: 700,
    utility: 600,
    danger: 500,
    visited: 100,
  } satisfies Record<MemoryPlaceKind, number>;

  return kindRank[place.kind] + Math.min(place.seenCount, 50);
}

function formatPosition(position: Vec3Like): string {
  return `${round(position.x)}, ${round(position.y)}, ${round(position.z)}`;
}

function distanceBetween(left: Vec3Like, right: Vec3Like): number {
  return Math.sqrt((left.x - right.x) ** 2 + (left.y - right.y) ** 2 + (left.z - right.z) ** 2);
}

function roundVec3(position: Vec3Like): Vec3Like {
  return {
    x: round(position.x),
    y: round(position.y),
    z: round(position.z),
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function safeFileName(value: string): string {
  return value.replace(/[^a-z0-9._-]+/giu, "_").replace(/^_+|_+$/gu, "") || "memory";
}

function clonePlace(place: MemoryPlace): MemoryPlace {
  const clone: MemoryPlace = {
    id: place.id,
    kind: place.kind,
    name: place.name,
    position: { ...place.position },
    firstSeenAt: place.firstSeenAt,
    lastSeenAt: place.lastSeenAt,
    seenCount: place.seenCount,
  };
  if (place.dimension) {
    clone.dimension = place.dimension;
  }
  if (place.notes) {
    clone.notes = place.notes;
  }
  return clone;
}

function clonePlayer(player: MemoryPlayer): MemoryPlayer {
  const clone: MemoryPlayer = {
    username: player.username,
    firstSeenAt: player.firstSeenAt,
    lastSeenAt: player.lastSeenAt,
    seenCount: player.seenCount,
  };
  if (player.lastPosition) {
    clone.lastPosition = { ...player.lastPosition };
  }
  if (player.notes) {
    clone.notes = player.notes;
  }
  return clone;
}

function cloneObservation(observation: MemoryObservation): MemoryObservation {
  const clone: MemoryObservation = {
    id: observation.id,
    createdAt: observation.createdAt,
    kind: observation.kind,
    summary: observation.summary,
  };
  if (observation.position) {
    clone.position = { ...observation.position };
  }
  return clone;
}

function cloneAutonomy(autonomy: MemoryAutonomyState): MemoryAutonomyState {
  const clone: MemoryAutonomyState = {
    mode: autonomy.mode,
  };
  if (autonomy.lastActedAt) {
    clone.lastActedAt = autonomy.lastActedAt;
  }
  if (autonomy.lastSuggestion) {
    clone.lastSuggestion = autonomy.lastSuggestion;
  }
  return clone;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
