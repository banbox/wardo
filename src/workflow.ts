import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadConfig } from "./config.js";
import { EventBus } from "./events.js";
import { LlmRegistry } from "./llm.js";
import { WardoStore } from "./store.js";
import type { TaskResult, TaskSpec, WorkflowSpec, RunOptions, WardoConfig } from "./types.js";
import { ClaudeAdapter } from "./agents/claude.js";
import { CodexAdapter } from "./agents/codex.js";
import { TaskAgent } from "./task-agent.js";
import { planWorkflow } from "./planner.js";
import { consoleRenderer } from "./renderer.js";
import { detectAgentEnvironment, type AgentEnvironment } from "./environment.js";

export function defineTask(task: TaskSpec): TaskSpec {
  return { ...task, dependsOn: task.dependsOn ? [...task.dependsOn] : [] };
}

export function defineWorkflow(workflow: WorkflowSpec): WorkflowSpec {
  return { ...workflow, tasks: workflow.tasks.map(defineTask) };
}

export async function forkWorkflow(sourceWorkspace: string, destinationWorkspace: string): Promise<string> {
  const source = resolve(sourceWorkspace);
  const destination = resolve(destinationWorkspace);
  await mkdir(destination, { recursive: true });
  await cp(join(source, ".wardo"), join(destination, ".wardo"), { recursive: true, force: true });
  const workflowPath = join(destination, ".wardo/workflow.json");
  const existing = JSON.parse(await readFile(workflowPath, "utf8")) as { runId?: string; parentRunId?: string };
  const runId = randomUUID();
  await writeFile(workflowPath, `${JSON.stringify({ ...existing, runId, parentRunId: existing.runId }, null, 2)}\n`, "utf8");
  return runId;
}

function flatten(tasks: TaskSpec[], parentId?: string): TaskSpec[] {
  return tasks.flatMap((task) => {
    const current = { ...task, ...(parentId ? { parentId } : {}) };
    return task.children?.length ? [current, ...flatten(task.children, task.id)] : [current];
  });
}

function validate(tasks: TaskSpec[]): void {
  const ids = new Set<string>();
  for (const task of tasks) {
    if (ids.has(task.id)) throw new Error(`Duplicate task id: ${task.id}`);
    ids.add(task.id);
  }
  for (const task of tasks) for (const dep of task.dependsOn ?? []) if (!ids.has(dep)) throw new Error(`Unknown dependency ${dep} for ${task.id}`);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error(`Task dependency cycle includes ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) visit(dep);
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of tasks) visit(task.id);
}

export class WorkflowRunner {
  private readonly tasks: TaskSpec[];
  private readonly statuses = new Map<string, TaskResult>();

  constructor(private readonly workflow: WorkflowSpec, private readonly agent: TaskAgent, private readonly store: WardoStore, private readonly config: WardoConfig, private readonly environment?: AgentEnvironment) {
    this.tasks = flatten(workflow.tasks);
    validate(this.tasks);
  }

  async run(options: RunOptions = {}): Promise<Map<string, TaskResult>> {
    const release = await this.store.lock();
    try {
      return await this.runLocked(options);
    } finally {
      await release();
    }
  }

  private async runLocked(options: RunOptions = {}): Promise<Map<string, TaskResult>> {
    const existing = options.resume ? await this.store.readJson<{ runId?: string }>("workflow.json") : undefined;
    const savedState = options.resume ? await this.store.readJson<Record<string, TaskResult>>("state.json") : undefined;
    const runId = options.runId ?? existing?.runId ?? randomUUID();
    if (savedState) {
      for (const [id, result] of Object.entries(savedState)) {
        // A resumed run requeues work that was interrupted or waiting for a retry.
        // Successful and terminal results remain durable and are skipped.
        if (["paused", "partial", "retry_wait", "running", "ready", "pending"].includes(result.status)) continue;
        this.statuses.set(id, result);
      }
    }
    await this.store.init(this.workflow.objective);
    await this.store.atomicWrite("workflow.json", { runId, workflow: this.workflow, environment: this.environment, config: { maxConcurrency: options.maxConcurrency ?? this.workflow.maxConcurrency ?? this.config.maxConcurrency } });
    await this.store.atomicWrite("plan.json", { schemaVersion: 1, objective: this.workflow.objective, tasks: this.tasks });
    const max = options.maxConcurrency ?? this.workflow.maxConcurrency ?? this.config.maxConcurrency;
    const active = new Map<string, Promise<{ id: string; result: TaskResult }>>();
    const done = (id: string) => this.statuses.get(id)?.status === "succeeded";
    const blocked = (id: string) => {
      const task = this.tasks.find((item) => item.id === id);
      return (task?.dependsOn ?? []).some((dep) => ["failed", "partial", "blocked", "cancelled", "unknown"].includes(this.statuses.get(dep)?.status ?? ""));
    };
    while (this.statuses.size < this.tasks.length || active.size) {
      for (const task of this.tasks) {
        if (this.statuses.has(task.id) || active.has(task.id)) continue;
        if (options.signal?.aborted) break;
        if (blocked(task.id)) {
          const result: TaskResult = { status: "blocked", text: "A dependency failed", attempt: 0 };
          this.statuses.set(task.id, result);
          await this.store.saveTaskState(task.id, result);
          await this.store.atomicWrite("state.json", Object.fromEntries(this.statuses));
          continue;
        }
        if (!(task.dependsOn ?? []).every(done)) continue;
        if (active.size >= max) break;
        const providerLimit = task.provider && task.provider !== "auto" ? this.config.providerConcurrency?.[task.provider] : undefined;
        if (providerLimit !== undefined) {
          const activeForProvider = [...active.keys()].map((id) => this.tasks.find((item) => item.id === id)).filter((item) => item?.provider === task.provider).length;
          if (activeForProvider >= providerLimit) continue;
        }
        const context = (task.dependsOn ?? []).map((dep) => `${dep}: ${this.statuses.get(dep)?.text ?? ""}`).join("\n\n");
        const running: TaskResult = { status: "running", text: "", attempt: 0 };
        this.statuses.set(task.id, running);
        await this.store.saveTaskState(task.id, running);
        await this.store.atomicWrite("state.json", Object.fromEntries(this.statuses));
        const promise = this.agent.execute(task, runId, context, options.signal)
          .then((result) => ({ id: task.id, result }))
          .catch((error) => ({ id: task.id, result: { status: options.signal?.aborted ? "paused" as const : "unknown" as const, text: "", error: String(error), attempt: 0 } }));
        active.set(task.id, promise);
      }
      if (!active.size) {
        if (options.signal?.aborted) break;
        const unresolved = this.tasks.filter((task) => !this.statuses.has(task.id));
        if (unresolved.length) throw new Error(`Scheduler stalled; unresolved tasks: ${unresolved.map((task) => task.id).join(", ")}`);
        break;
      }
      const completed = await Promise.race(active.values());
      active.delete(completed.id);
      this.statuses.set(completed.id, completed.result);
      await this.store.saveTaskState(completed.id, completed.result);
      await this.store.atomicWrite("state.json", Object.fromEntries(this.statuses));
      if (completed.result.status === "paused" || options.signal?.aborted) {
        const pending = await Promise.all(active.values());
        for (const item of pending) {
          active.delete(item.id);
          this.statuses.set(item.id, item.result);
          await this.store.saveTaskState(item.id, item.result);
        }
        await this.store.atomicWrite("state.json", Object.fromEntries(this.statuses));
        break;
      }
      if (completed.result.status === "failed" && this.workflow.failFast) {
        for (const task of this.tasks) if (!this.statuses.has(task.id)) this.statuses.set(task.id, { status: "cancelled", text: "failFast", attempt: 0 });
        await this.store.atomicWrite("state.json", Object.fromEntries(this.statuses));
      }
    }
    await this.store.atomicWrite("state.json", Object.fromEntries(this.statuses));
    return this.statuses;
  }
}

export interface ExecuteOptions extends RunOptions {
  prompt: string;
  workflow?: WorkflowSpec;
  config?: WardoConfig;
  plan?: "single" | "auto";
  stream?: boolean;
}

export interface WorkflowRunOptions extends RunOptions {
  config?: WardoConfig;
  stream?: boolean;
}

export async function runWorkflow(workflow: WorkflowSpec, options: WorkflowRunOptions = {}): Promise<Map<string, TaskResult>> {
  const workspace = resolve(options.workspace ?? process.cwd());
  const config = options.config ?? await loadConfig({ workspace });
  const environment = await detectAgentEnvironment();
  const store = new WardoStore(workspace);
  const events = new EventBus(store);
  events.subscribe(consoleRenderer({ enabled: options.stream !== false }));
  const firstProvider = (type: "openai" | "anthropic") => {
    const name = config.providerOrder?.find((item) => config.providers[item]?.type === type) ?? type;
    return config.providers[name];
  };
  const openai = firstProvider("openai");
  const anthropic = firstProvider("anthropic");
  const claudeEnv = Object.fromEntries(Object.entries({
    ...process.env,
    ...(anthropic?.apiKey ? { ANTHROPIC_API_KEY: anthropic.apiKey } : {}),
    ...(anthropic?.baseUrl ? { ANTHROPIC_BASE_URL: anthropic.baseUrl } : {}),
  }).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const adapters = {
    codex: new CodexAdapter({
      apiKey: openai?.apiKey,
      baseUrl: openai?.baseUrl,
      model: config.agentDefaults.codex?.model,
      sandboxMode: config.agentDefaults.codex?.sandboxMode as "read-only" | "workspace-write" | "danger-full-access" | undefined,
      approvalPolicy: config.agentDefaults.codex?.approvalPolicy as "never" | "on-request" | "on-failure" | "untrusted" | undefined,
    }),
    claude: new ClaudeAdapter({
      model: config.agentDefaults.claude?.model,
      fallbackModel: config.agentDefaults.claude?.fallbackModel,
      permissionMode: config.agentDefaults.claude?.permissionMode,
      env: claudeEnv,
    }),
  };
  const registry = new LlmRegistry(config, workspace);
  const agent = new TaskAgent({ adapters, registry, config, store, events, workspace, activeProvider: environment.active });
  return new WorkflowRunner(workflow, agent, store, config, environment).run(options);
}

export async function execute(options: ExecuteOptions): Promise<Map<string, TaskResult>> {
  const workspace = resolve(options.workspace ?? process.cwd());
  const config = options.config ?? await loadConfig({ workspace });
  const registry = new LlmRegistry(config, workspace);
  const workflow = options.workflow ?? (options.plan === "auto"
    ? await planWorkflow(options.prompt, registry, options.signal)
    : defineWorkflow({
      id: "main",
      objective: options.prompt,
      ...(options.maxConcurrency !== undefined ? { maxConcurrency: options.maxConcurrency } : {}),
      tasks: [defineTask({ id: "main", goal: options.prompt, acceptance: "完成目标并提供验证结果", provider: "auto" })],
    }));
  return runWorkflow(workflow, { ...options, config });
}
