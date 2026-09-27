# wardo

`wardo` turns a complex prompt into a durable TypeScript workflow that can run Codex and Claude Code agents. It stores the plan, task state, events, attempt results and judge decisions in the workspace `.wardo` directory.

Install the agent skill from the skills directory:

```bash
npx skills add banbox/wardo --skill wardo
```

Browse it at [skills.sh/banbox/wardo/wardo](https://skills.sh/banbox/wardo/wardo).

## Install and build

```bash
npm install
npm run check
npm run build
```

Node.js 20 or newer is required. No Python runtime is used.

Install the skill into the detected host with:

```bash
npm run build
node dist/cli.js install-skill
# or choose one explicitly:
node dist/cli.js install-skill --agent codex
node dist/cli.js install-skill --agent claude
```

At runtime Wardo records the installed agents, detected active host, versions and detection source in `.wardo/workflow.json`. Automatic tasks use that active host first. Set `WARDO_ACTIVE_AGENT=codex` or `WARDO_ACTIVE_AGENT=claude` when the parent environment does not expose a host marker.

## Configure providers

Create `~/.wardo/config.yml`:

```yaml
maxConcurrency: 3
modelPreferences:
  - anthropic:claude-haiku-4-5
  - openai:gpt-5-mini
providers:
  openai:
    type: openai
    apiKey: ${OPENAI_API_KEY}
    baseUrl: ${OPENAI_BASE_URL}
    models: [gpt-5-mini]
  anthropic:
    type: anthropic
    apiKey: ${ANTHROPIC_API_KEY}
    baseUrl: ${ANTHROPIC_BASE_URL}
    models: [claude-haiku-4-5]
  local:
    type: openai-compatible
    apiKey: ${LOCAL_LLM_API_KEY}
    baseUrl: ${LOCAL_LLM_BASE_URL}
    models: [local-fast]
retry:
  delaysMs: [60000, 180000, 480000, 1200000]
  maxAttempts: 5
```

Environment variables override file values. Supported overrides include `WARDO_MAX_CONCURRENCY`, `WARDO_MODEL_PREFERENCES`, `WARDO_PROVIDER_<NAME>_API_KEY`, `WARDO_PROVIDER_<NAME>_BASE_URL`, `WARDO_PROVIDER_<NAME>_MODELS`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `ANTHROPIC_API_KEY`, and `ANTHROPIC_BASE_URL`.

## Run a workflow

```ts
import { execute } from "wardo";

await execute({
  prompt: "检查项目中的认证错误，修复并运行测试",
  workspace: process.cwd(),
  maxConcurrency: 3,
  resume: true,
});
```

需要让 planner 自动拆分任务时加入 `plan: "auto"`：

```ts
await execute({ prompt: "完成一个需要分析、实现和测试的复杂改造", plan: "auto", resume: true });
```

For a stable multi-step plan, use `defineWorkflow`, `defineTask`, and `runWorkflow` from the package. Use `reviewScript` at a checkpoint when the workflow script needs an agent review and update.

The CLI supports `wardo run`, `wardo run --plan auto`, `wardo resume`, `wardo status`, `wardo env`, and `wardo fork <destination>`. Pressing `Ctrl-C` persists the current task as paused; `wardo resume` continues from the saved `.wardo` state.

The current implementation includes planner-driven decomposition, a durable scheduler, provider adapters, judge requests, retry classification, event storage, resume loading, configuration loading and the `reviewScript` checkpoint helper. Interactive pause commands and automatic review triggers are the next implementation slice.

### Provider 列表与故障切换

`~/.wardo/config.yml` 的 `providers` 支持按顺序排列的列表。每一项可使用 `openai`、`anthropic` 或 `local`（OpenAI 兼容接口）类型；`name` 可选，用于在模型偏好中引用该项：

```yaml
providers:
  - name: primary
    type: openai
    apiKey: ${OPENAI_API_KEY}
    models: [gpt-5-mini]
  - type: anthropic
    apiKey: ${ANTHROPIC_API_KEY}
    models: [claude-haiku-4-5]
  - type: local
    baseUrl: http://127.0.0.1:11434/v1
    models: [local-fast]
providerHealth:
  cooldownMs: 300000
  probeProbability: 0.1
```

Wardo 按列表顺序选择 provider。遇到网络、限流、503/5xx 等临时故障时，会把 provider 写入工作区 `.wardo/provider-health.json`，在冷却时间内跳过它，并以 `probeProbability` 的概率进行恢复探测；成功请求会清除该 provider 的故障状态。旧的对象格式仍兼容。
