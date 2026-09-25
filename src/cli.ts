#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { execute, forkWorkflow, runWorkflow } from "./workflow.js";
import { installSkill } from "./skill-install.js";
import { detectAgentEnvironment } from "./environment.js";

const args = process.argv.slice(2);
const command = args[0];
if (command === "run") {
  const autoPlan = args.includes("--plan=auto") || args.includes("--plan") && args[args.indexOf("--plan") + 1] === "auto";
  const stream = !args.includes("--no-stream");
  const prompt = args.filter((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--plan").slice(1).join(" ").trim();
  if (!prompt) {
    console.error("Usage: wardo run <prompt>");
    process.exitCode = 2;
  } else {
    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort(new Error("Paused by SIGINT")));
    await execute({ prompt, workspace: process.cwd(), resume: true, plan: autoPlan ? "auto" : "single", stream, signal: controller.signal });
  }
} else if (command === "resume") {
  const prompt = await readFile(join(process.cwd(), ".wardo/prompt.md"), "utf8");
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort(new Error("Paused by SIGINT")));
  let plan: { objective?: string; tasks?: unknown[] } | undefined;
  try {
    plan = JSON.parse(await readFile(join(process.cwd(), ".wardo/plan.json"), "utf8")) as { objective?: string; tasks?: unknown[] };
  } catch {
    plan = undefined;
  }
  if (Array.isArray(plan?.tasks)) {
    await runWorkflow({ id: "resumed", objective: plan?.objective ?? prompt, tasks: plan.tasks as never[] }, { workspace: process.cwd(), resume: true, signal: controller.signal });
  } else {
    await execute({ prompt, workspace: process.cwd(), resume: true, signal: controller.signal });
  }
} else if (command === "status") {
  try {
    console.log(await readFile(join(process.cwd(), ".wardo/state.json"), "utf8"));
  } catch {
    console.error("No .wardo run state found");
    process.exitCode = 1;
  }
} else if (command === "fork") {
  const destination = args[1];
  if (!destination) {
    console.error("Usage: wardo fork <destination>");
    process.exitCode = 2;
  } else {
    console.log(await forkWorkflow(process.cwd(), destination));
  }
} else if (command === "install-skill") {
  const requested = args[1] === "--agent" ? args[2] : undefined;
  if (requested !== undefined && requested !== "codex" && requested !== "claude") {
    console.error("--agent must be codex or claude");
    process.exitCode = 2;
  } else {
    for (const result of await installSkill(requested as "codex" | "claude" | undefined)) console.log(`${result.agent}: ${result.target}`);
  }
} else if (command === "env") {
  console.log(JSON.stringify(await detectAgentEnvironment(), null, 2));
} else if (command === "config") {
  console.log("Wardo config: ~/.wardo/config.yml");
} else {
  console.log("Usage: wardo run [--plan auto] <prompt> | wardo resume | wardo status | wardo fork <destination> | wardo env | wardo install-skill");
}
