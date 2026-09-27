import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProviderHealth } from "../src/provider-health.js";

test("persists provider outages, skips during cooldown, and clears on success", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "wardo-health-"));
  const file = join(workspace, ".wardo", "provider-health.json");
  const health = new ProviderHealth(file, 1_000, 0, () => 1);
  await health.failure("primary", new Error("503"), 100);
  assert.equal(await health.available("primary", 500), false);
  assert.equal(await health.available("primary", 1_101), true);
  await health.success("primary", 1_102);
  assert.equal(JSON.parse(await readFile(file, "utf8")).primary.failures, 0);
  await rm(workspace, { recursive: true, force: true });
});
