import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultConfig } from "../src/config.js";
import { WardoStore } from "../src/store.js";
import { defineTask, defineWorkflow, forkWorkflow, WorkflowRunner } from "../src/workflow.js";
import type { TaskResult } from "../src/types.js";
import type { TaskAgent } from "../src/task-agent.js";

test("runs independent tasks concurrently and waits for dependencies", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "wardo-workflow-"));
  let active = 0;
  let peak = 0;
  const order: string[] = [];
  const fake = {
    async execute(task: { id: string }): Promise<TaskResult> {
      active += 1;
      peak = Math.max(peak, active);
      order.push(`start:${task.id}`);
      await new Promise((resolve) => setTimeout(resolve, task.id === "a" ? 15 : 5));
      active -= 1;
      order.push(`end:${task.id}`);
      return { status: "succeeded", text: `result-${task.id}`, attempt: 1 };
    },
  } as unknown as TaskAgent;
  const workflow = defineWorkflow({
    id: "test",
    objective: "test",
    maxConcurrency: 2,
    tasks: [
      defineTask({ id: "a", goal: "a", acceptance: "a" }),
      defineTask({ id: "b", goal: "b", acceptance: "b" }),
      defineTask({ id: "c", dependsOn: ["a", "b"], goal: "c", acceptance: "c" }),
    ],
  });
  const result = await new WorkflowRunner(workflow, fake, new WardoStore(workspace), defaultConfig()).run();
  assert.equal(result.get("c")?.status, "succeeded");
  assert.equal(peak, 2);
  assert.ok(order.indexOf("start:c") > order.indexOf("end:a"));
  assert.ok(order.indexOf("start:c") > order.indexOf("end:b"));
  await rm(workspace, { recursive: true, force: true });
});

test("rejects dependency cycles", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "wardo-cycle-"));
  const fake = { execute: async () => ({ status: "succeeded", text: "", attempt: 1 }) } as unknown as TaskAgent;
  assert.throws(() => new WorkflowRunner(defineWorkflow({
    id: "cycle",
    objective: "cycle",
    tasks: [
      defineTask({ id: "a", dependsOn: ["b"], goal: "a", acceptance: "a" }),
      defineTask({ id: "b", dependsOn: ["a"], goal: "b", acceptance: "b" }),
    ],
  }), fake, new WardoStore(workspace), defaultConfig()), /cycle/);
  await rm(workspace, { recursive: true, force: true });
});

test("resume skips tasks already recorded as succeeded", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "wardo-resume-"));
  let calls = 0;
  const fake = {
    async execute(task: { id: string }): Promise<TaskResult> {
      calls += 1;
      return { status: "succeeded", text: `result-${task.id}`, attempt: 1 };
    },
  } as unknown as TaskAgent;
  const workflow = defineWorkflow({ id: "resume", objective: "resume", tasks: [defineTask({ id: "one", goal: "one", acceptance: "one" })] });
  await new WorkflowRunner(workflow, fake, new WardoStore(workspace), defaultConfig()).run();
  await new WorkflowRunner(workflow, fake, new WardoStore(workspace), defaultConfig()).run({ resume: true });
  assert.equal(calls, 1);
  await rm(workspace, { recursive: true, force: true });
});

test("persists a paused task and leaves dependents for resume", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "wardo-pause-"));
  const fake = {
    async execute(task: { id: string }): Promise<TaskResult> {
      return { status: task.id === "first" ? "paused" : "succeeded", text: "", attempt: 1 };
    },
  } as unknown as TaskAgent;
  const workflow = defineWorkflow({
    id: "pause",
    objective: "pause",
    tasks: [
      defineTask({ id: "first", goal: "first", acceptance: "first" }),
      defineTask({ id: "second", dependsOn: ["first"], goal: "second", acceptance: "second" }),
    ],
  });
  const result = await new WorkflowRunner(workflow, fake, new WardoStore(workspace), defaultConfig()).run();
  assert.equal(result.get("first")?.status, "paused");
  assert.equal(result.has("second"), false);
  await rm(workspace, { recursive: true, force: true });
});

test("forks a durable run with a new id and parent reference", async () => {
  const source = await mkdtemp(join(tmpdir(), "wardo-fork-source-"));
  const destination = await mkdtemp(join(tmpdir(), "wardo-fork-destination-"));
  const fake = { execute: async () => ({ status: "succeeded", text: "", attempt: 1 }) } as unknown as TaskAgent;
  await new WorkflowRunner(defineWorkflow({ id: "fork", objective: "fork", tasks: [defineTask({ id: "one", goal: "one", acceptance: "one" })] }), fake, new WardoStore(source), defaultConfig()).run();
  const original = JSON.parse(await readFile(join(source, ".wardo/workflow.json"), "utf8")) as { runId: string };
  const forked = await forkWorkflow(source, destination);
  const copied = JSON.parse(await readFile(join(destination, ".wardo/workflow.json"), "utf8")) as { runId: string; parentRunId: string };
  assert.equal(forked, copied.runId);
  assert.equal(copied.parentRunId, original.runId);
  await rm(source, { recursive: true, force: true });
  await rm(destination, { recursive: true, force: true });
});
