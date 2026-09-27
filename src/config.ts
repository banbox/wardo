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
  const source = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const nestedType = ["openai", "anthropic", "local", "openai-compatible"].find((key) => source[key] && typeof source[key] === "object");
  const raw = nestedType
    ? { ...(source[nestedType] as Record<string, unknown>), type: nestedType }
    : source;
  const type = raw.type === "anthropic" || raw.type === "openai-compatible" || raw.type === "local" ? raw.type : "openai";
  const headers = raw.headers && typeof raw.headers === "object"
    ? Object.fromEntries(Object.entries(raw.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
    : undefined;
  return {
    type,
    ...(typeof raw.name === "string" && raw.name ? { name: raw.name } : {}),
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
    providerOrder: ["openai", "anthropic"],
    providerHealth: { cooldownMs: 300_000, probeProbability: 0.1 },
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
  const rawProviderValue = fileConfig.providers;
  const providers: Record<string, ProviderConfig> = {};
  const providerOrder: string[] = [];
  const listMode = Array.isArray(rawProviderValue);
  if (listMode) {
    rawProviderValue.forEach((value, index) => {
      const normalized = normalizeProvider(value);
      const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
      const requested = typeof raw.name === "string" && raw.name ? raw.name : undefined;
      const baseName = requested ?? (normalized.type === "openai-compatible" ? "local" : normalized.type);
      const name = providers[baseName] ? `${baseName}-${index + 1}` : baseName;
      providers[name] = { ...normalized, ...(requested ? { name: requested } : {}) };
      providerOrder.push(name);
    });
  } else if (rawProviderValue && typeof rawProviderValue === "object") {
    for (const [name, value] of Object.entries(rawProviderValue as Record<string, unknown>)) {
      providers[name] = normalizeProvider(value);
      providerOrder.push(name);
    }
  }
  if (listMode) {
    for (const name of providerOrder) {
      const current = providers[name];
      if (current) providers[name] = { ...current, ...envProvider(env, name, current.type) };
    }
  } else {
    for (const [name, type] of [["openai", "openai"], ["anthropic", "anthropic"]] as const) {
      providers[name] = { ...providers[name], ...envProvider(env, name, type) };
      if (!providerOrder.includes(name)) providerOrder.push(name);
    }
  }
  if (env.WARDO_PROVIDER_LOCAL_API_KEY || env.LOCAL_LLM_API_KEY || env.WARDO_PROVIDER_LOCAL_BASE_URL || env.LOCAL_LLM_BASE_URL) {
    const local = providers.local ?? { type: "local" as const };
    providers.local = { ...local, ...envProvider(env, "local", "local") };
    if (!providerOrder.includes("local")) providerOrder.push("local");
  }

  const retryRaw = fileConfig.retry && typeof fileConfig.retry === "object" ? fileConfig.retry as Record<string, unknown> : {};
  const delays = asNumberArray(retryRaw.delaysMs);
  const maxConcurrency = Number(env.WARDO_MAX_CONCURRENCY ?? fileConfig.maxConcurrency ?? base.maxConcurrency);
  const preferences = (env.WARDO_MODEL_PREFERENCES ?? asStringArray(fileConfig.modelPreferences).join(","))
    .split(",").map((x) => x.trim()).filter(Boolean);
  const workspace = options.workspace ? resolve(options.workspace) : typeof fileConfig.workspace === "string" ? resolve(fileConfig.workspace) : undefined;
  const healthRaw = fileConfig.providerHealth && typeof fileConfig.providerHealth === "object" ? fileConfig.providerHealth as Record<string, unknown> : {};
  const cooldownMs = Number(healthRaw.cooldownMs ?? base.providerHealth?.cooldownMs ?? 300_000);
  const probeProbability = Number(healthRaw.probeProbability ?? base.providerHealth?.probeProbability ?? 0.1);
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
    providerOrder: providerOrder.length ? providerOrder : [...(base.providerOrder ?? ["openai", "anthropic"])],
    providerHealth: {
      cooldownMs: Number.isFinite(cooldownMs) && cooldownMs >= 0 ? cooldownMs : 300_000,
      probeProbability: Number.isFinite(probeProbability) ? Math.min(1, Math.max(0, probeProbability)) : 0.1,
    },
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
