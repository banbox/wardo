import { strict as assert } from "node:assert";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultConfig } from "../src/config.js";
import { EventBus } from "../src/events.js";
import { TaskAgent } from "../src/task-agent.js";
import { WardoStore } from "../src/store.js";
import type { AgentAdapter, AgentEvent, AgentSession, TaskSpec } from "../src/types.js";

test("task agent always records a judge decision after agent output", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "wardo-agent-"));
  const store = new WardoStore(workspace);
  await store.init();
  const adapter: AgentAdapter = {
    async start(input): Promise<AgentSession> { return { provider: "codex", sessionId: "session-1", cwd: input.cwd }; },
    async resume(session): Promise<AgentSession> { return session; },
    async *stream(): AsyncIterable<AgentEvent> { yield { provider: "codex", rawType: "item.completed", type: "text_delta", text: "done" }; },
    async cancel(): Promise<void> {},
  };
  const registry = { generate: async () => ({ object: { verdict: "pass", reason: "meets acceptance", retryable: false, missing: [] }, text: "pass", provider: "openai", model: "gpt-5-mini" }) };
  const agent = new TaskAgent({
    adapters: { codex: adapter },
    registry: registry as never,
    config: { ...defaultConfig(), retry: { delaysMs: [0], maxAttempts: 1 } },
    store,
    events: new EventBus(store),
    workspace,
  });
  const task: TaskSpec = { id: "build", goal: "build", acceptance: "done", provider: "codex" };
  const result = await agent.execute(task, "run-1", "");
  assert.equal(result.status, "succeeded");
  const judge = JSON.parse(await readFile(join(workspace, ".wardo/tasks/build/attempt-0001/judge.json"), "utf8")) as { verdict: string };
  assert.equal(judge.verdict, "pass");
  await rm(workspace, { recursive: true, force: true });
});

test("continues a partial task in the same provider session", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "wardo-agent-continue-"));
  const store = new WardoStore(workspace);
  await store.init();
  let starts = 0;
  let resumes = 0;
  let judgments = 0;
  const adapter: AgentAdapter = {
    async start(input): Promise<AgentSession> { starts += 1; return { provider: "codex", sessionId: "session-continue", cwd: input.cwd }; },
    async resume(session): Promise<AgentSession> { resumes += 1; return session; },
    async *stream(): AsyncIterable<AgentEvent> { yield { provider: "codex", rawType: "item.completed", type: "text_delta", text: "progress" }; },
    async cancel(): Promise<void> {},
  };
  const registry = { generate: async () => {
    judgments += 1;
    return { object: judgments === 1 ? { verdict: "continue", reason: "run the test", nextPrompt: "run the test", retryable: true, missing: ["test"] } : { verdict: "pass", reason: "done", retryable: false, missing: [] }, text: "", provider: "openai", model: "gpt-5-mini" };
  } };
  const agent = new TaskAgent({
    adapters: { codex: adapter },
    registry: registry as never,
    config: { ...defaultConfig(), retry: { delaysMs: [0], maxAttempts: 2 } },
    store,
    events: new EventBus(store),
    workspace,
    sleepFn: async () => {},
  });
  const result = await agent.execute({ id: "continue", goal: "continue", acceptance: "done", provider: "codex" }, "run-continue", "");
  assert.equal(result.status, "succeeded");
  assert.equal(starts, 1);
  assert.equal(resumes, 1);
  await rm(workspace, { recursive: true, force: true });
});

test("resumes a persisted paused session after Ctrl-C", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "wardo-agent-resume-"));
  const store = new WardoStore(workspace);
  await store.init();
  await store.saveSession({ provider: "codex", sessionId: "persisted-session", cwd: workspace });
  await store.saveTaskState("resume", { status: "paused", text: "partial", attempt: 1, provider: "codex", sessionId: "persisted-session" });
  let resumed = 0;
  const adapter: AgentAdapter = {
    async start(): Promise<AgentSession> { throw new Error("start should not be called"); },
    async resume(session): Promise<AgentSession> { resumed += 1; return session; },
    async *stream(): AsyncIterable<AgentEvent> { yield { provider: "codex", rawType: "done", type: "text_delta", text: "resumed" }; },
    async cancel(): Promise<void> {},
  };
  const registry = { generate: async () => ({ object: { verdict: "pass", reason: "done", retryable: false, missing: [] }, text: "pass", provider: "openai", model: "gpt-5-mini" }) };
  const agent = new TaskAgent({
    adapters: { codex: adapter },
    registry: registry as never,
    config: { ...defaultConfig(), retry: { delaysMs: [0], maxAttempts: 1 } },
    store,
    events: new EventBus(store),
    workspace,
  });
  const result = await agent.execute({ id: "resume", goal: "resume", acceptance: "done", provider: "codex" }, "run-resume", "");
  assert.equal(result.status, "succeeded");
  assert.equal(resumed, 1);
  assert.equal(result.attempt, 2);
  await rm(workspace, { recursive: true, force: true });
});
