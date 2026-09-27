#!/usr/bin/env node
/**
 * Small, reusable Node runner for the wardo skill.
 * It bootstraps a local checkout when the package is not installed, then
 * executes one prompt with the same defaults used by the CLI.
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function ensureWardoPackage({ packageName = "wardo", cwd = process.cwd(), env = process.env } = {}) {
  const requireFromScript = createRequire(import.meta.url);
  try {
    return requireFromScript.resolve(packageName);
  } catch {
    const source = env.WARDO_LOCAL_PATH ?? env.WARDO_PACKAGE ?? packageName;
    if (isAbsolute(source) && !existsSync(resolve(source, "dist/index.js"))) {
      execFileSync("npm", ["run", "build", "--prefix", source], { stdio: "inherit", env });
    }
    execFileSync("npm", ["install", "--no-save", source], { cwd, stdio: "inherit", env });
    return requireFromScript.resolve(packageName);
  }
}

export function parseRunArgs(argv) {
  const options = { workspace: process.cwd(), resume: true, plan: "single" };
  const prompt = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--plan" || arg.startsWith("--plan=")) {
      options.plan = arg.includes("=") ? arg.split("=", 2)[1] : (argv[++index] ?? "single");
    } else if (arg === "--workspace") {
      options.workspace = resolve(argv[++index] ?? options.workspace);
    } else if (arg === "--no-resume") {
      options.resume = false;
    } else if (arg === "--max-concurrency") {
      options.maxConcurrency = Number(argv[++index]);
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      prompt.push(arg);
    }
  }
  return { options, prompt: prompt.join(" ").trim() };
}

export async function runPrompt(prompt, options = {}) {
  if (!prompt?.trim()) throw new Error("A prompt is required");
  ensureWardoPackage({ cwd: options.workspace ?? process.cwd() });
  const { execute } = await import("wardo");
  const { help: _help, ...runOptions } = options;
  return execute({ prompt, workspace: options.workspace ?? process.cwd(), resume: true, ...runOptions });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { options, prompt } = parseRunArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node wardo-run.mjs [--plan auto] [--workspace DIR] [--max-concurrency N] [--no-resume] <prompt>");
  } else {
    const results = await runPrompt(prompt, options);
    for (const [id, result] of results) console.log(`${id}: ${result.status}`);
  }
}
