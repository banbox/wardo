import { strict as assert } from "node:assert";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";

test("loads ~/.wardo style YAML and environment overrides", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wardo-config-"));
  const file = join(dir, "config.yml");
  await writeFile(file, [
    "maxConcurrency: 2",
    "modelPreferences:",
    "  - anthropic:claude-haiku-4-5",
    "providers:",
    "  local:",
    "    type: openai-compatible",
    "    baseUrl: ${LOCAL_URL}",
    "    apiKey: ${LOCAL_KEY}",
    "    models: [local-fast]",
    "retry:",
    "  delaysMs: [100, 300]",
    "  maxAttempts: 3",
  ].join("\n"));
  const config = await loadConfig({ path: file, env: {
    LOCAL_URL: "https://llm.example/v1",
    LOCAL_KEY: "secret-value",
    WARDO_MAX_CONCURRENCY: "4",
    WARDO_MODEL_PREFERENCES: "local:local-fast,openai:gpt-5-mini",
    OPENAI_API_KEY: "openai-key",
  } });
  assert.equal(config.maxConcurrency, 4);
  assert.deepEqual(config.modelPreferences, ["local:local-fast", "openai:gpt-5-mini"]);
  assert.equal(config.providers.local?.baseUrl, "https://llm.example/v1");
  assert.equal(config.providers.local?.apiKey, "secret-value");
  assert.deepEqual(config.retry.delaysMs, [100, 300]);
  assert.equal(config.providers.openai?.apiKey, "openai-key");
  await rm(dir, { recursive: true, force: true });
});

test("loads ordered provider lists including local and named entries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wardo-provider-list-"));
  const file = join(dir, "config.yml");
  await writeFile(file, [
    "providers:",
    "  - name: primary",
    "    type: openai",
    "    models: [gpt-test]",
    "  - type: anthropic",
    "    models: [claude-test]",
    "  - type: local",
    "    baseUrl: http://localhost:11434/v1",
    "    models: [local-test]",
  ].join("\n"));
  const config = await loadConfig({ path: file, workspace: dir, env: {} });
  assert.deepEqual(config.providerOrder, ["primary", "anthropic", "local"]);
  assert.equal(config.providers.primary?.type, "openai");
  assert.equal(config.providers.anthropic?.type, "anthropic");
  assert.equal(config.providers.local?.type, "local");
  await rm(dir, { recursive: true, force: true });
});

