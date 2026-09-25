import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentAdapter, AgentEvent, AgentInput, AgentSession } from "../types.js";

function id(): string {
  return `claude-${crypto.randomUUID()}`;
}

export interface ClaudeAdapterOptions {
  model?: string;
  fallbackModel?: string;
  permissionMode?: string;
  additionalDirectories?: string[];
  maxTurns?: number;
  maxBudgetUsd?: number;
  allowDangerouslySkipPermissions?: boolean;
  env?: Record<string, string | undefined>;
}

type ActiveQuery = { close?: () => void | Promise<void>; interrupt?: () => Promise<void> | void };

export class ClaudeAdapter implements AgentAdapter {
  readonly provider = "claude" as const;
  private readonly queries = new Map<string, ActiveQuery>();

  constructor(private readonly options: ClaudeAdapterOptions = {}) {}

  async start(input: AgentInput & { cwd: string; additionalDirectories?: string[] }): Promise<AgentSession> {
    return { provider: "claude", sessionId: id(), cwd: input.cwd, ...(input.model ? { model: input.model } : {}) };
  }

  async resume(session: AgentSession, _input: AgentInput): Promise<AgentSession> {
    return session;
  }

  async *stream(session: AgentSession, input: AgentInput): AsyncIterable<AgentEvent> {
    const abortController = new AbortController();
    const abort = () => abortController.abort(input.signal?.reason);
    input.signal?.addEventListener("abort", abort, { once: true });
    const options = {
      cwd: session.cwd,
      additionalDirectories: this.options.additionalDirectories,
      model: input.model ?? session.model ?? this.options.model,
      fallbackModel: this.options.fallbackModel,
      permissionMode: this.options.permissionMode,
      maxTurns: this.options.maxTurns,
      maxBudgetUsd: this.options.maxBudgetUsd,
      allowDangerouslySkipPermissions: this.options.allowDangerouslySkipPermissions,
      env: this.options.env,
      abortController,
      includePartialMessages: true,
      ...(session.sessionId.startsWith("claude-") ? {} : { resume: session.sessionId }),
      ...(input.outputSchema ? { outputFormat: { type: "json_schema", schema: input.outputSchema } } : {}),
    };
    const active = query({ prompt: input.prompt, options: options as never }) as unknown as AsyncIterable<Record<string, unknown>> & ActiveQuery;
    this.queries.set(session.sessionId, active);
    try {
      for await (const message of active) {
        const rawType = String(message.type ?? message.subtype ?? "status");
        const subtype = typeof message.subtype === "string" ? message.subtype : "";
        const content = message.message && typeof message.message === "object" ? (message.message as Record<string, unknown>).content : undefined;
        const text = typeof message.text === "string"
          ? message.text
          : Array.isArray(content)
            ? content.filter((part): part is Record<string, unknown> => !!part && typeof part === "object").map((part) => typeof part.text === "string" ? part.text : "").join("") || undefined
            : typeof message.result === "string" ? message.result : undefined;
        if (rawType === "system" && subtype === "init" && typeof message.session_id === "string") session.sessionId = message.session_id;
        yield {
          provider: "claude",
          rawType,
          type: rawType === "result" || subtype.startsWith("error") ? "turn_completed"
            : rawType === "assistant" || rawType === "stream_event" ? "text_delta"
            : rawType.includes("tool") || rawType.includes("task") ? "tool_call"
            : rawType === "system" && subtype === "init" ? "session_started" : "status",
          ...(text ? { text } : {}),
          payload: message,
        };
      }
    } finally {
      input.signal?.removeEventListener("abort", abort);
      this.queries.delete(session.sessionId);
      await active.close?.();
    }
  }

  async cancel(session: AgentSession, reason?: string): Promise<void> {
    const active = this.queries.get(session.sessionId);
    if (active?.interrupt) await active.interrupt();
    await active?.close?.();
    if (!active) return;
    throwIfCancelled(reason);
  }
}

function throwIfCancelled(reason?: string): void {
  if (reason) return;
}
