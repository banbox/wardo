import { generateObject, generateText, streamText, type LanguageModel } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import { classifyError } from "./retry.js";
import type { ProviderConfig, WardoConfig } from "./types.js";
import { ProviderHealth, providerHealthPath } from "./provider-health.js";

export interface ModelRef {
  provider?: string;
  model?: string;
}

export interface GenerateRequest<T> {
  role: "planner" | "judge" | "summary" | "general";
  prompt: string;
  schema?: z.ZodType<T>;
  model?: ModelRef | string;
  maxRetries?: number;
  signal?: AbortSignal;
}

export interface GenerateResult<T> {
  object?: T;
  text: string;
  usage?: unknown;
  provider: string;
  model: string;
}

export class LlmRegistry {
  private readonly health: ProviderHealth;

  constructor(private readonly config: WardoConfig, workspace?: string) {
    this.health = new ProviderHealth(
      providerHealthPath(workspace),
      config.providerHealth?.cooldownMs,
      config.providerHealth?.probeProbability,
    );
  }

  resolve(ref?: ModelRef | string, role?: GenerateRequest<unknown>["role"]): { name: string; model: string; provider: ProviderConfig; providerName: string } {
    const candidates = this.candidateNames(ref, role);
    for (const candidate of candidates) {
      const parts = candidate.split(":");
      const maybeProvider = parts[0] ?? "";
      const rest = parts.slice(1);
      const model = rest.length ? rest.join(":") : maybeProvider;
      const providerName = rest.length
        ? this.config.providers[maybeProvider]
          ? maybeProvider
          : this.findProviderByAlias(maybeProvider)
        : this.findProvider(model);
      const provider = this.config.providers[providerName];
      if (provider && model) return { name: candidate, model, provider, providerName };
    }
    const providerName = this.config.providerOrder?.[0] ?? Object.keys(this.config.providers)[0] ?? "openai";
    const provider = this.config.providers[providerName] ?? { type: "openai" as const };
    const model = provider.models?.[0] ?? (provider.type === "anthropic" ? "claude-haiku-4-5" : "gpt-5-mini");
    return { name: `${providerName}:${model}`, model, provider, providerName };
  }

  private candidateNames(ref?: ModelRef | string, role?: GenerateRequest<unknown>["role"]): string[] {
    const explicit = typeof ref === "string" ? ref : ref?.model ? `${ref.provider ? `${ref.provider}:` : ""}${ref.model}` : undefined;
    const preferred = role === "judge" && this.config.judge?.model
      ? [this.config.judge.provider ? `${this.config.judge.provider}:${this.config.judge.model}` : this.config.judge.model, ...this.config.modelPreferences]
      : [...this.config.modelPreferences];
    return [...new Set(explicit ? [explicit] : preferred)];
  }

  private resolveCandidates(ref?: ModelRef | string, role?: GenerateRequest<unknown>["role"]): Array<{ name: string; model: string; provider: ProviderConfig; providerName: string }> {
    const order = this.config.providerOrder?.length ? this.config.providerOrder : Object.keys(this.config.providers);
    const fallbackNames = order.flatMap((providerName) => {
      const provider = this.config.providers[providerName];
      if (!provider) return [];
      const models = provider.models?.length ? provider.models : [provider.type === "anthropic" ? "claude-haiku-4-5" : "gpt-5-mini"];
      return models.map((model) => `${providerName}:${model}`);
    });
    const names = [...new Set([...this.candidateNames(ref, role), ...fallbackNames])];
    const candidates = names.map((name) => this.resolve(name, "general"));
    return candidates.length ? candidates : [this.resolve(undefined, role)];
  }

  private findProvider(model: string): string {
    return Object.entries(this.config.providers).find(([, provider]) => provider.models?.includes(model))?.[0]
      ?? this.config.providerOrder?.[0]
      ?? "openai";
  }

  private findProviderByAlias(alias: string): string {
    const normalized = alias === "openai-compatible" ? "local" : alias;
    return this.config.providerOrder?.find((name) => {
      const type = this.config.providers[name]?.type;
      return name === alias || type === normalized || (normalized === "local" && type === "openai-compatible");
    }) ?? alias;
  }

  private languageModel(resolved: { name: string; model: string; provider: ProviderConfig; providerName: string }): { model: LanguageModel; providerName: string; modelName: string } {
    const settings = {
      apiKey: resolved.provider.apiKey,
      baseURL: resolved.provider.baseUrl,
      headers: resolved.provider.headers,
    };
    if (resolved.provider.type === "anthropic") {
      const provider = createAnthropic(settings);
      return { model: provider(resolved.model), providerName: resolved.providerName, modelName: resolved.model };
    }
    const provider = createOpenAI(settings);
    return { model: provider(resolved.model), providerName: resolved.providerName, modelName: resolved.model };
  }

  async generate<T>(request: GenerateRequest<T>): Promise<GenerateResult<T>> {
    let lastError: unknown;
    for (const resolved of this.resolveCandidates(request.model, request.role)) {
      if (!(await this.health.available(resolved.providerName))) continue;
      const selected = this.languageModel(resolved);
      try {
        if (request.schema) {
          const result = await (generateObject as unknown as (options: Record<string, unknown>) => Promise<Record<string, unknown>>)({
            model: selected.model,
            schema: request.schema,
            prompt: request.prompt,
            maxRetries: request.maxRetries ?? this.config.judge?.maxRetries ?? 2,
            ...(request.signal ? { abortSignal: request.signal } : {}),
          });
          await this.health.success(selected.providerName);
          return {
            object: result.object as T,
            text: typeof result.text === "string" ? result.text : JSON.stringify(result.object),
            usage: result.usage,
            provider: selected.providerName,
            model: selected.modelName,
          };
        }
        const result = await generateText({ model: selected.model, prompt: request.prompt, maxRetries: request.maxRetries ?? 2, ...(request.signal ? { abortSignal: request.signal } : {}) });
        await this.health.success(selected.providerName);
        return { text: result.text, usage: result.usage, provider: selected.providerName, model: selected.modelName };
      } catch (error) {
        lastError = error;
        if (!classifyError(error).retryable) throw error;
        await this.health.failure(selected.providerName, error);
      }
    }
    throw lastError ?? new Error("No LLM provider configured");
  }

  async *stream(request: GenerateRequest<unknown>): AsyncIterable<{ type: string; text?: string; raw?: unknown }> {
    let lastError: unknown;
    for (const resolved of this.resolveCandidates(request.model, request.role)) {
      if (!(await this.health.available(resolved.providerName))) continue;
      const selected = this.languageModel(resolved);
      try {
        const result = streamText({ model: selected.model, prompt: request.prompt, maxRetries: request.maxRetries ?? 2, ...(request.signal ? { abortSignal: request.signal } : {}) });
        for await (const part of result.fullStream) {
          const value = part as unknown as Record<string, unknown>;
          yield { type: String(value.type ?? "status"), ...(typeof value.text === "string" ? { text: value.text } : {}), raw: part };
        }
        await this.health.success(selected.providerName);
        return;
      } catch (error) {
        lastError = error;
        if (!classifyError(error).retryable) throw error;
        await this.health.failure(selected.providerName, error);
      }
    }
    throw lastError ?? new Error("No LLM provider configured or all providers are temporarily unavailable");
  }
}
