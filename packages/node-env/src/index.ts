import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export interface DotEnvLoadResult {
  loaded: boolean;
  path?: string;
  keys: string[];
}

export function loadDotEnv(startDirectory = process.cwd()): DotEnvLoadResult {
  const filePath = findDotEnv(startDirectory);
  if (!filePath) {
    return {
      loaded: false,
      keys: [],
    };
  }

  const entries = parseDotEnv(readFileSync(filePath, "utf8"));
  const keys: string[] = [];

  for (const [key, value] of entries) {
    if (process.env[key] !== undefined) {
      continue;
    }

    process.env[key] = value;
    keys.push(key);
  }

  return {
    loaded: true,
    path: filePath,
    keys,
  };
}

export function parseDotEnv(text: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/u)) {
    const parsed = parseLine(rawLine);
    if (parsed) {
      entries.set(parsed.key, parsed.value);
    }
  }

  return entries;
}

function findDotEnv(startDirectory: string): string | undefined {
  let current = path.resolve(startDirectory);

  while (true) {
    const candidate = path.join(current, ".env");
    if (existsSync(candidate)) {
      return candidate;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }

    current = parent;
  }
}

function parseLine(rawLine: string): { key: string; value: string } | undefined {
  const line = rawLine.trim();
  if (!line || line.startsWith("#")) {
    return undefined;
  }

  const normalized = line.startsWith("export ") ? line.slice("export ".length).trimStart() : line;
  const separatorIndex = normalized.indexOf("=");
  if (separatorIndex <= 0) {
    return undefined;
  }

  const key = normalized.slice(0, separatorIndex).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
    return undefined;
  }

  const value = parseValue(normalized.slice(separatorIndex + 1).trim());
  return {
    key,
    value,
  };
}

function parseValue(rawValue: string): string {
  if (rawValue.startsWith("\"")) {
    return parseQuotedValue(rawValue, "\"").replace(/\\n/gu, "\n").replace(/\\r/gu, "\r").replace(/\\"/gu, "\"");
  }

  if (rawValue.startsWith("'")) {
    return parseQuotedValue(rawValue, "'");
  }

  const commentIndex = rawValue.search(/\s#/u);
  const value = commentIndex === -1 ? rawValue : rawValue.slice(0, commentIndex);
  return value.trim();
}

function parseQuotedValue(rawValue: string, quote: "\"" | "'"): string {
  let escaped = false;
  let value = "";

  for (let index = 1; index < rawValue.length; index += 1) {
    const char = rawValue[index];
    if (!char) {
      break;
    }

    if (escaped) {
      value += `\\${char}`;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === quote) {
      return value;
    }

    value += char;
  }

  return value;
}
