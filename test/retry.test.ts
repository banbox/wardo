import { strict as assert } from "node:assert";
import test from "node:test";
import { classifyError, retryDelay } from "../src/retry.js";

test("classifies upstream failures as retryable", () => {
  assert.equal(classifyError({ status: 503, message: "overloaded" }).retryable, true);
  assert.equal(classifyError({ statusCode: 429, message: "rate limit" }).class, "rate_limit");
  assert.equal(classifyError({ status: 401, message: "invalid api key" }).retryable, false);
  assert.equal(classifyError(new Error("fetch failed")).class, "network");
});

test("uses persisted exponential retry schedule", () => {
  const policy = { delaysMs: [60_000, 180_000, 480_000, 1_200_000], maxAttempts: 5 };
  assert.equal(retryDelay(policy, 1), 60_000);
  assert.equal(retryDelay(policy, 4), 1_200_000);
  assert.equal(retryDelay(policy, 5), undefined);
  assert.equal(retryDelay(policy, 1, 99), 99);
});
