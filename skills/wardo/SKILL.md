---
name: wardo
description: Transform complex user requests into TypeScript workflows that orchestrate Codex and Claude Code agents with durable .wardo state.
---

# wardo skill

Generate a TypeScript script using the `wardo` package. Do not generate Python.

Use one `execute({ prompt, workspace })` call for a simple task. For a complex task, use `defineWorkflow` and `defineTask` with explicit goals, acceptance criteria, dependencies, and a provider hint. Keep independent tasks independent so the scheduler can run up to the configured concurrency. Every task result is checked by a separate lightweight judge request and is persisted under `.wardo`.

The script must:

- preserve the original user request and task acceptance criteria;
- pass dependency results through summaries and artifact references;
- use `resume: true` for long-running work;
- avoid putting API keys in the script or `.wardo` files;
- leave simple file discovery and deterministic data processing to TypeScript code;
- request a Codex or Claude review when the workflow itself needs to change.

Provider keys and URLs are configured in `~/.wardo/config.yml` or environment variables. The generated script should not hard-code a provider secret.

## Runtime bootstrap

The skill can be installed in either `~/.codex/skills/wardo` or `~/.claude/skills/wardo`. Before generating or running a script, identify the active host:

- `WARDO_ACTIVE_AGENT=codex` means Codex is the current host;
- `WARDO_ACTIVE_AGENT=claude` means Claude Code is the current host;
- if the variable is absent, the runtime checks `CODEX_*` and `CLAUDE_CODE*` environment variables and the installed binaries.

Pass the detected value to the generated script so automatic provider selection starts with the current host. An explicit task provider still takes precedence.

The generated script must bootstrap the package before importing it. This supports a freshly created project and local development where the package has not been installed yet:

```ts
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const packageName = "wardo";
const requireFromScript = createRequire(import.meta.url);
try {
  requireFromScript.resolve(packageName);
} catch {
  const source = process.env.WARDO_LOCAL_PATH ?? process.env.WARDO_PACKAGE ?? packageName;
  if (source.startsWith("/") && !existsSync(resolve(source, "dist/index.js"))) {
    execFileSync("npm", ["run", "build", "--prefix", source], { stdio: "inherit", env: process.env });
  }
  execFileSync("npm", ["install", "--no-save", source], {
    cwd: process.cwd(),
    stdio: "inherit",
    env: process.env,
  });
}

const { execute } = await import(packageName);
await execute({
  prompt: "用户目标",
  workspace: process.cwd(),
  resume: true,
});
```

For local testing, set `WARDO_LOCAL_PATH=/data/wardo` (or the absolute path of this checkout). The bootstrap must use an absolute local path when the npm package has not been published. The `wardo install-skill` command installs this skill into every detected agent, or into a selected target with `--agent codex` or `--agent claude`.
