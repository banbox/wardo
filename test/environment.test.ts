import { strict as assert } from "node:assert";
import test from "node:test";
import { detectAgentEnvironment } from "../src/environment.js";

test("records the active Codex host from execution environment", async () => {
  const result = await detectAgentEnvironment({
    PATH: process.env.PATH,
    CODEX_THREAD_ID: "thread-test",
    CODEX_VERSION: "codex-cli test",
  });
  assert.equal(result.active, "codex");
  assert.ok(result.detectedBy.includes("Codex environment variables"));
  assert.equal(typeof result.installed.codex, "boolean");
});

test("explicit active agent takes precedence", async () => {
  const result = await detectAgentEnvironment({
    PATH: process.env.PATH,
    WARDO_ACTIVE_AGENT: "claude",
    CODEX_THREAD_ID: "thread-test",
  });
  assert.equal(result.active, "claude");
  assert.deepEqual(result.detectedBy, ["WARDO_ACTIVE_AGENT"]);
});

