import { strict as assert } from "node:assert";
import test from "node:test";
import { consoleRenderer } from "../src/renderer.js";
import type { WardoEvent } from "../src/types.js";

test("foreground renderer owns task output and renders SDK lifecycle events", () => {
  let output = "";
  let error = "";
  const stream = { write: (value: string) => { output += value; return true; } } as unknown as NodeJS.WriteStream;
  const errorStream = { write: (value: string) => { error += value; return true; } } as unknown as NodeJS.WriteStream;
  const render = consoleRenderer({ stream, error: errorStream });
  const base = { schemaVersion: 1 as const, runId: "run", taskId: "task", attemptId: "attempt", seq: 1, ts: new Date().toISOString() };
  render({ ...base, type: "text_delta", payload: { text: "hello" } });
  render({ ...base, type: "tool_call", payload: { rawType: "item.started" } });
  render({ ...base, type: "error", payload: { error: "failed" } });
  assert.match(output, /\[task\] hello/);
  assert.match(output, /\[task\] tool_call \(item.started\)/);
  assert.match(error, /failed/);
});
