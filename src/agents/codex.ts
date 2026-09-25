import { Codex } from "@openai/codex-sdk";
import type { Thread } from "@openai/codex-sdk";
import type { AgentAdapter, AgentEvent, AgentInput, AgentSession } from "../types.js";

function id(): string {
  return `codex-${crypto.randomUUID()}`;
}

export interface CodexAdapterOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy?: "never" | "on-request" | "on-failure" | "untrusted";
  additionalDirectories?: string[];
  skipGitRepoCheck?: boolean;
}

export class CodexAdapter implements AgentAdapter {
  readonly provider = "codex" as const;
  private readonly client: Codex;
  private readonly threads = new Map<string, Thread>();
  private readonly controllers = new Map<string, AbortController>();

  constructor(private readonly options: CodexAdapterOptions = {}) {
    this.client = new Codex({
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    });
  }

  async start(input: AgentInput & { cwd: string; additionalDirectories?: string[] }): Promise<AgentSession> {
    const session: AgentSession = { provider: "codex", sessionId: id(), cwd: input.cwd, ...(input.model ? { model: input.model } : {}) };
    const thread = this.client.startThread({
      ...(input.model ?? this.options.model ? { model: input.model ?? this.options.model } : {}),
      workingDirectory: input.cwd,
      sandboxMode: this.options.sandboxMode ?? "workspace-write",
      approvalPolicy: this.options.approvalPolicy ?? "on-request",
      additionalDirectories: input.additionalDirectories ?? this.options.additionalDirectories,
      skipGitRepoCheck: this.options.skipGitRepoCheck ?? false,
    });
    this.threads.set(session.sessionId, thread);
    return session;
  }

  async resume(session: AgentSession, input: AgentInput): Promise<AgentSession> {
    const thread = this.client.resumeThread(session.sessionId);
    this.threads.set(session.sessionId, thread);
    return session;
  }

  async *stream(session: AgentSession, input: AgentInput): AsyncIterable<AgentEvent> {
    const thread = this.threads.get(session.sessionId);
    if (!thread) throw new Error(`Unknown Codex session: ${session.sessionId}`);
    const controller = new AbortController();
    const abort = () => controller.abort(input.signal?.reason);
    input.signal?.addEventListener("abort", abort, { once: true });
    this.controllers.set(session.sessionId, controller);
    try {
      const streamed = await thread.runStreamed(input.prompt, { signal: controller.signal, ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}) });
      for await (const event of streamed.events) {
        const raw = event as unknown as Record<string, unknown>;
        if (raw.type === "thread.started" && typeof raw.thread_id === "string") {
          const old = session.sessionId;
          session.sessionId = raw.thread_id;
          this.threads.set(session.sessionId, thread);
          this.threads.delete(old);
        }
        const type = String(raw.type ?? "status");
        const item = raw.item as Record<string, unknown> | undefined;
        const text = typeof item?.text === "string" ? item.text : typeof raw.message === "string" ? raw.message : undefined;
        yield {
          provider: "codex",
          rawType: type,
          type: type.includes("error") || type.includes("failed") ? "error"
            : type === "turn.completed" ? "turn_completed"
            : type === "turn.started" ? "turn_started"
            : type.includes("file_change") ? "file_change"
            : item?.type === "reasoning" ? "reasoning"
            : item?.type === "command_execution" || item?.type === "mcp_tool_call" ? "tool_call"
            : text ? "text_delta" : "status",
          ...(text ? { text } : {}),
          payload: event,
        };
      }
    } finally {
      input.signal?.removeEventListener("abort", abort);
      this.controllers.delete(session.sessionId);
    }
  }

  async cancel(session: AgentSession, reason?: string): Promise<void> {
    this.controllers.get(session.sessionId)?.abort(new Error(reason ?? "Cancelled"));
  }
}

