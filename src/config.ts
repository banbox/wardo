import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";
import type { ProviderConfig, WardoConfig } from "./types.js";

const defaultRetry = [60_000, 180_000, 480_000, 1_200_000];

export interface LoadConfigOptions {
  path?: string;
  env?: NodeJS.ProcessEnv;
  workspace?: string;
}

function expand(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key: string) => env[key] ?? "");
  }
  if (Array.isArray(value)) return value.map((item) => expand(item, env));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v, env)]));
  }
  return value;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function asNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => typeof item === "number" || typeof item === "string" ? Number(item) : NaN).filter(Number.isFinite);
}

function normalizeProvider(value: unknown): ProviderConfig {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const type = raw.type === "anthropic" || raw.type === "openai-compatible" ? raw.type : "openai";
  const headers = raw.headers && typeof raw.headers === "object"
    ? Object.fromEntries(Object.entries(raw.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
    : undefined;
  return {
    type,
    ...(typeof raw.apiKey === "string" && raw.apiKey ? { apiKey: raw.apiKey } : {}),
    ...(typeof raw.baseUrl === "string" && raw.baseUrl ? { baseUrl: raw.baseUrl } : {}),
    ...(asStringArray(raw.models).length ? { models: asStringArray(raw.models) } : {}),
    ...(headers ? { headers } : {}),
  };
}

function envProvider(env: NodeJS.ProcessEnv, name: string, type: ProviderConfig["type"]): ProviderConfig {
  const upper = name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const standard = name === "openai" ? "OPENAI" : name === "anthropic" ? "ANTHROPIC" : undefined;
  const apiKey = env[`WARDO_PROVIDER_${upper}_API_KEY`] ?? (standard ? env[`${standard}_API_KEY`] : undefined);
  const baseUrl = env[`WARDO_PROVIDER_${upper}_BASE_URL`] ?? (standard ? env[`${standard}_BASE_URL`] : undefined);
  const models = (env[`WARDO_PROVIDER_${upper}_MODELS`] ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  return {
    type,
    ...(apiKey ? { apiKey } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(models.length ? { models } : {}),
  };
}

export function defaultConfig(): WardoConfig {
  return {
    maxConcurrency: 3,
    retry: { delaysMs: [...defaultRetry], maxAttempts: 5 },
    providers: {
      openai: { type: "openai" },
      anthropic: { type: "anthropic" },
    },
    modelPreferences: [],
    agentDefaults: {},
  };
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<WardoConfig> {
  const env = options.env ?? process.env;
  const configPath = options.path
    ? resolve(options.path)
    : env.WARDO_CONFIG
      ? resolve(env.WARDO_CONFIG)
      : join(env.WARDO_HOME ? resolve(env.WARDO_HOME) : join(homedir(), ".wardo"), "config.yml");
  let fileConfig: Record<string, unknown> = {};
  try {
    const text = await readFile(configPath, "utf8");
    const parsed = parse(text);
    if (parsed && typeof parsed === "object") fileConfig = expand(parsed, env) as Record<string, unknown>;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code !== "ENOENT") throw error;
  }

  const base = defaultConfig();
  const rawProviders = fileConfig.providers && typeof fileConfig.providers === "object"
    ? fileConfig.providers as Record<string, unknown>
    : {};
  const providers: Record<string, ProviderConfig> = {};
  for (const [name, value] of Object.entries(rawProviders)) providers[name] = normalizeProvider(value);
  for (const [name, type] of [["openai", "openai"], ["anthropic", "anthropic"]] as const) {
    providers[name] = {
      ...providers[name],
      ...envProvider(env, name, type),
    };
  }

  const retryRaw = fileConfig.retry && typeof fileConfig.retry === "object" ? fileConfig.retry as Record<string, unknown> : {};
  const delays = asNumberArray(retryRaw.delaysMs);
  const maxConcurrency = Number(env.WARDO_MAX_CONCURRENCY ?? fileConfig.maxConcurrency ?? base.maxConcurrency);
  const preferences = (env.WARDO_MODEL_PREFERENCES ?? asStringArray(fileConfig.modelPreferences).join(","))
    .split(",").map((x) => x.trim()).filter(Boolean);
  const workspace = options.workspace ? resolve(options.workspace) : typeof fileConfig.workspace === "string" ? resolve(fileConfig.workspace) : undefined;
  return {
    workspace,
    maxConcurrency: Number.isFinite(maxConcurrency) && maxConcurrency > 0 ? Math.floor(maxConcurrency) : 3,
    ...(fileConfig.providerConcurrency && typeof fileConfig.providerConcurrency === "object"
      ? { providerConcurrency: fileConfig.providerConcurrency as WardoConfig["providerConcurrency"] }
      : {}),
    retry: {
      delaysMs: delays.length ? delays : [...base.retry.delaysMs],
      maxAttempts: Number(retryRaw.maxAttempts ?? base.retry.maxAttempts),
    },
    providers: Object.keys(providers).length ? providers : base.providers,
    modelPreferences: preferences,
    agentDefaults: (fileConfig.agentDefaults && typeof fileConfig.agentDefaults === "object"
      ? fileConfig.agentDefaults as WardoConfig["agentDefaults"]
      : {}),
    ...(fileConfig.judge && typeof fileConfig.judge === "object" ? { judge: fileConfig.judge as WardoConfig["judge"] } : {}),
  };
}

export function configFilePath(): string {
  return join(homedir(), ".wardo", "config.yml");
}

export function configDirectory(): string {
  return dirname(configFilePath());
}
