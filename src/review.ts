import { copyFile, readFile } from "node:fs/promises";
import { basename, relative } from "node:path";
import { spawn } from "node:child_process";
import type { AgentAdapter } from "./types.js";
import { WardoStore } from "./store.js";

export interface ScriptReviewOptions {
  adapter: AgentAdapter;
  scriptPath: string;
  workspace: string;
  objective: string;
  plan: unknown;
  revision?: number;
  store: WardoStore;
  signal?: AbortSignal;
}

export interface ScriptReviewResult {
  changed: boolean;
  passed: boolean;
  output: string;
  typecheckOutput?: string;
  snapshotPath: string;
}

export async function reviewScript(options: ScriptReviewOptions): Promise<ScriptReviewResult> {
  const revision = options.revision ?? 0;
  const snapshot = `scripts/${basename(options.scriptPath)}.${revision}.bak`;
  await options.store.atomicWrite(snapshot, await readFile(options.scriptPath, "utf8"));
  const before = await readFile(options.scriptPath, "utf8");
  const prompt = [
      "审查当前 Wardo 工作流脚本，并直接修复发现的问题。",
      "只允许修改该脚本，不要修改业务源代码、凭证或 .wardo 历史事件。",
      `工作流目标：${options.objective}`,
      `当前计划：${JSON.stringify(options.plan)}`,
      `脚本路径：${relative(options.workspace, options.scriptPath)}`,
      "请检查 TypeScript 类型、任务依赖、恢复行为和验收标准。",
    ].join("\n\n");
  const session = await options.adapter.start({
    prompt,
    cwd: options.workspace,
    signal: options.signal,
  });
  let output = "";
  for await (const event of options.adapter.stream(session, { prompt, ...(options.signal ? { signal: options.signal } : {}) })) {
    if (event.text) output += event.text;
  }
  const after = await readFile(options.scriptPath, "utf8");
  const typecheck = await runTypecheck(options.scriptPath, options.workspace, options.signal);
  return {
    changed: before !== after,
    passed: typecheck.ok,
    output,
    ...(typecheck.output ? { typecheckOutput: typecheck.output } : {}),
    snapshotPath: snapshot,
  };
}

async function runTypecheck(scriptPath: string, cwd: string, signal?: AbortSignal): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("npx", ["tsc", "--noEmit", scriptPath], { cwd, signal, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.on("error", (error) => resolve({ ok: false, output: `${output}${error.message}` }));
    child.on("exit", (code) => resolve({ ok: code === 0, output }));
  });
}
