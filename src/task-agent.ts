import { z } from "zod";
import { EventBus, normalizeAgentEvent } from "./events.js";
import { classifyError, retryDelay, sleep } from "./retry.js";
import type { AgentAdapter, AgentEvent, TaskResult, TaskSpec, WardoConfig } from "./types.js";
import { WardoStore } from "./store.js";
import { LlmRegistry } from "./llm.js";
import type { AgentName } from "./environment.js";

const JudgeDecision = z.object({
  verdict: z.enum(["pass", "continue", "fail"]),
  reason: z.string(),
  nextPrompt: z.string().optional(),
  retryable: z.boolean().default(false),
  missing: z.array(z.string()).default([]),
});

export interface TaskAgentOptions {
  adapters: Partial<Record<"codex" | "claude", AgentAdapter>>;
  registry: LlmRegistry;
  config: WardoConfig;
  store: WardoStore;
  events: EventBus;
  workspace: string;
  activeProvider?: AgentName;
  sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export class TaskAgent {
  constructor(private readonly options: TaskAgentOptions) {}

  async execute(task: TaskSpec, runId: string, context: string, signal?: AbortSignal): Promise<TaskResult> {
    const maxAttempts = task.maxAttempts ?? this.options.config.retry.maxAttempts;
    let followUp = "";
    let last: TaskResult = { status: "unknown", text: "", attempt: 0 };
    const providers = task.provider === "codex" || task.provider === "claude"
      ? [{ provider: task.provider, model: task.model }]
      : this.providerCandidates(task);
    let providerIndex = 0;
    let continuation: { provider: "codex" | "claude"; session: Awaited<ReturnType<AgentAdapter["start"]>> } | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const attemptId = `attempt-${String(attempt).padStart(4, "0")}`;
      const plan = providers[providerIndex] ?? { provider: "codex" as const };
      const provider = plan.provider;
      const adapter = this.options.adapters[provider];
      if (!adapter) return { status: "failed", text: "", error: `No ${provider} adapter configured`, attempt };
      const prompt = [
        `任务目标：${task.goal}`,
        `验收标准：${task.acceptance}`,
        context ? `前置任务结果：\n${context}` : "",
        followUp ? `上一次验收反馈：\n${followUp}` : "",
        "请完成任务，记录实际修改、验证命令和剩余风险。",
      ].filter(Boolean).join("\n\n");
      const model = task.model?.includes(":") ? task.model.split(":").slice(1).join(":") : task.model ?? plan.model;
      let start: Awaited<ReturnType<AgentAdapter["start"]>> | undefined;
      let text = "";
      let error: unknown;
      try {
        const input = { prompt, cwd: this.options.workspace, ...(model ? { model } : {}), ...(signal ? { signal } : {}) };
        start = continuation?.provider === provider
          ? await adapter.resume(continuation.session, input)
          : await adapter.start(input);
        await this.options.events.emit({ runId, taskId: task.id, attemptId, type: "session_started", provider, payload: { sessionId: start.sessionId } });
        for await (const event of adapter.stream(start, { prompt, ...(model ? { model } : {}), ...(signal ? { signal } : {}) })) {
          if (event.text) text += event.text;
          await this.options.events.emit(normalizeAgentEvent(event, runId, task.id, attemptId));
        }
        continuation = { provider, session: start };
      } catch (caught) {
        error = caught;
        await this.options.events.emit({ runId, taskId: task.id, attemptId, type: "error", provider, payload: { error: String(caught) } });
      }
      if (error) {
        if (signal?.aborted) {
          last = { status: "paused", text, error: "Paused", attempt, ...(start?.sessionId ? { sessionId: start.sessionId } : {}) };
          await this.options.store.saveAttempt(task.id, attemptId, last, text);
          return last;
        }
        const classified = classifyError(error);
        last = { status: classified.retryable ? "retry_wait" : "failed", text, error: classified.message, attempt, ...(start?.sessionId ? { sessionId: start.sessionId } : {}) };
        if (!classified.retryable || attempt >= maxAttempts) {
          await this.options.store.saveAttempt(task.id, attemptId, last, text);
          return last;
        }
        const delay = retryDelay(this.options.config.retry, attempt);
        await this.options.events.emit({ runId, taskId: task.id, attemptId, type: "retry_wait", provider, payload: { delayMs: delay, error: classified } });
        if (delay !== undefined) await (this.options.sleepFn ?? sleep)(delay, signal);
        providerIndex = Math.min(providerIndex + 1, providers.length - 1);
        continuation = undefined;
        continue;
      }
      await this.options.events.emit({ runId, taskId: task.id, attemptId, type: "awaiting_judge", provider });
      let decision: z.infer<typeof JudgeDecision>;
      try {
        const judged = await this.options.registry.generate({
          role: "judge",
          prompt: [
            `总目标：${task.goal}`,
            `验收标准：${task.acceptance}`,
            context ? `前置任务和历史摘要：\n${context}` : "",
            followUp ? `此前验收反馈：\n${followUp}` : "",
            "以下是子 agent 的最终输出：",
            text || "（没有文本输出，请根据事件和工作区判断）",
            "判断是否完成。若未完成，给出下一次执行应采取的明确动作。",
          ].join("\n\n"),
          schema: JudgeDecision,
          signal,
        });
        decision = judged.object as z.infer<typeof JudgeDecision>;
      } catch (caught) {
        if (signal?.aborted) {
          last = { status: "paused", text, error: "Paused during judge", attempt, ...(start?.sessionId ? { sessionId: start.sessionId } : {}) };
          await this.options.store.saveAttempt(task.id, attemptId, last, text);
          return last;
        }
        const classified = classifyError(caught);
        last = { status: classified.retryable ? "retry_wait" : "failed", text, error: `Judge failed: ${classified.message}`, attempt, ...(start?.sessionId ? { sessionId: start.sessionId } : {}) };
        await this.options.store.saveAttempt(task.id, attemptId, last, text);
        if (!classified.retryable || attempt >= maxAttempts) return last;
        const delay = retryDelay(this.options.config.retry, attempt);
        if (delay !== undefined) await (this.options.sleepFn ?? sleep)(delay, signal);
        providerIndex = Math.min(providerIndex + 1, providers.length - 1);
        continuation = undefined;
        continue;
      }
      await this.options.store.atomicWrite(`tasks/${task.id}/${attemptId}/judge.json`, decision);
      last = { status: decision.verdict === "pass" ? "succeeded" : decision.verdict === "continue" ? "partial" : "failed", text, attempt, ...(start?.sessionId ? { sessionId: start.sessionId } : {}) };
      await this.options.store.saveAttempt(task.id, attemptId, last, text);
      if (decision.verdict === "pass") return last;
      if (decision.verdict === "fail" && !decision.retryable) return last;
      followUp = decision.nextPrompt ?? decision.reason;
    }
    return last;
  }

  private providerCandidates(task: TaskSpec): Array<{ provider: "codex" | "claude"; model?: string }> {
    if (task.model?.startsWith("claude:") || task.model?.startsWith("anthropic:")) return [{ provider: "claude", model: task.model.split(":").slice(1).join(":") }, { provider: "codex" }];
    if (task.model?.startsWith("codex:") || task.model?.startsWith("openai:")) return [{ provider: "codex", model: task.model.split(":").slice(1).join(":") }, { provider: "claude" }];
    const preferred = this.options.config.modelPreferences
      .map((item) => {
        const [providerName, ...modelParts] = item.split(":");
        const provider = providerName === "anthropic" ? "claude" : providerName === "openai" ? "codex" : undefined;
        return provider ? { provider, ...(modelParts.length ? { model: modelParts.join(":") } : {}) } : undefined;
      })
      .filter((item): item is { provider: "codex" | "claude"; model?: string } => item !== undefined);
    const fallback = this.options.activeProvider === "claude"
      ? [{ provider: "claude" as const }, { provider: "codex" as const }]
      : [{ provider: "codex" as const }, { provider: "claude" as const }];
    const activePreferred = this.options.activeProvider
      ? preferred.find((item) => item.provider === this.options.activeProvider)
      : undefined;
    const initial = activePreferred
      ? [activePreferred]
      : this.options.activeProvider
        ? [{ provider: this.options.activeProvider }]
        : [];
    const seen = new Set<string>();
    return [...initial, ...preferred, ...fallback].filter((item) => {
      if (seen.has(item.provider)) return false;
      seen.add(item.provider);
      return true;
    });
  }
}
