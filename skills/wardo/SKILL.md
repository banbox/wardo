---
name: wardo
description: Turn complex requests into durable Node/TypeScript or Python workflows that orchestrate Codex and Claude Code agents.
---

# Wardo

Use Wardo when a request benefits from several agent tasks, dependencies, retries, resumability, or an independent judge. Keep simple deterministic work in the host language and use one Wardo task for the agent work.

## Choose a runtime

- Node.js 20+: `import { execute, defineTask, defineWorkflow } from "wardo"`.
- Python 3.10+: `from wardo import execute, define_task, define_workflow`.
- Python can run without installation when the checkout's `python` directory is on `PYTHONPATH`; `python -m wardo run [--plan auto] <prompt>` is the CLI form.

The equivalent calls are `execute(prompt, workspace, resume, plan)` in Python and `execute({ prompt, workspace, resume, plan })` in TypeScript. For a DAG, define tasks with `id`, `goal`, `acceptance`, `dependsOn`/`depends_on`, and an optional `provider`; define the workflow with `objective`, `tasks`, `maxConcurrency`/`max_concurrency`, and `failFast`/`fail_fast`. Dependency results are passed as task context. Keep independent tasks independent so concurrency can be used.

Every task is judged and its state is persisted in `.wardo`. Preserve the user's request and acceptance criteria, pass summaries or artifact references between tasks, use `resume: true` for work that may be interrupted, and keep provider secrets in `~/.wardo/config.yml` or environment variables.

## Reusable runners

Use the bundled helpers when you need a ready-to-run script or want to avoid repeating bootstrap code:

```bash
node skills/wardo/scripts/wardo-run.mjs --plan auto "拆解并完成这个复杂请求"
python skills/wardo/scripts/wardo-run.py --plan auto "拆解并完成这个复杂请求"
```

`wardo-run.mjs` exports `ensureWardoPackage`, `parseRunArgs`, and `runPrompt`; it honors `WARDO_LOCAL_PATH`/`WARDO_PACKAGE`, builds an unpublished local checkout when needed, and installs it with `npm --no-save`. The Python helper honors `WARDO_PYTHON_PATH` and adds the bundled runtime path. Copy a helper next to a generated script if the skill directory will not be present at runtime.

## Host and provider selection

Set `WARDO_ACTIVE_AGENT=codex` or `WARDO_ACTIVE_AGENT=claude` when the host is ambiguous. Otherwise Wardo checks the host environment and installed binaries. A task's explicit provider takes precedence. Do not hard-code API keys, provider URLs, or a host-specific agent choice in generated code.

Use `wardo env` to inspect detection, `wardo status` to read `.wardo/state.json`, `wardo resume` to continue a run, `wardo fork <destination>` to copy a run, and `wardo install-skill [--agent codex|claude]` to install this skill.
