import { strict as assert } from "node:assert";
import test from "node:test";
import { defaultConfig } from "../src/config.js";
import { LlmRegistry } from "../src/llm.js";

test("resolves model preference lists across configured providers", () => {
  const config = defaultConfig();
  config.providers.local = { type: "openai-compatible", baseUrl: "https://local.invalid/v1", models: ["fast"] };
  config.modelPreferences = ["local:fast", "anthropic:claude-haiku-4-5"];
  const resolved = new LlmRegistry(config).resolve();
  assert.equal(resolved.providerName, "local");
  assert.equal(resolved.model, "fast");
  assert.equal(resolved.provider.baseUrl, "https://local.invalid/v1");
});

