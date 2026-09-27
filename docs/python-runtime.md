# Python runtime

The `python/wardo` package is a dependency-free implementation of the Wardo
runtime contract. It uses the same `.wardo` directory as the TypeScript
implementation, so a paused run can be inspected and resumed by either CLI.

## Provider wire formats

Provider entries use the existing `type`, `apiKey`, `baseUrl` and `models`
fields. `requestFormat` is optional:

| Provider | Format | Endpoint |
| --- | --- | --- |
| `openai` / `openai-compatible` | `openai-chat` (default) | `/chat/completions` |
| `openai` / compatible | `openai-responses` | `/responses` |
| `anthropic` | `anthropic-messages` (default) | `/messages` |

The registry retries network, rate limit and server errors using `retry` and
falls back through configured providers. Authentication and malformed request
errors stop immediately.

## Agents and tests

The default Python adapters invoke `codex exec` and `claude -p`. A deployment
can pass adapters implementing `start`, `resume` and `run` to `execute` or
`run_workflow`; this is also how unit tests avoid real model calls. Planner and
judge requests use the same registry and provider configuration as task work.

Run the optional Python tests with:

```bash
python -m unittest discover -s test -p 'python_*test.py'
```
