import type { WardoEvent } from "./types.js";

export interface RenderOptions {
  stream?: NodeJS.WriteStream;
  error?: NodeJS.WriteStream;
  enabled?: boolean;
}

export function consoleRenderer(options: RenderOptions = {}): (event: WardoEvent) => void {
  const output = options.stream ?? process.stdout;
  const error = options.error ?? process.stderr;
  return (event) => {
    if (options.enabled === false) return;
    const payload = event.payload && typeof event.payload === "object" ? event.payload as Record<string, unknown> : {};
    const text = typeof payload.text === "string" ? payload.text : undefined;
    if (text && event.type === "text_delta") {
      output.write(`[${event.taskId}] ${text}\n`);
      return;
    }
    if (event.type === "error") {
      error.write(`[${event.taskId}] error: ${JSON.stringify(payload.error ?? payload)}\n`);
      return;
    }
    if (["session_started", "turn_started", "turn_completed", "awaiting_judge", "retry_wait", "tool_call", "file_change"].includes(event.type)) {
      const rawType = typeof payload.rawType === "string" ? ` (${payload.rawType})` : "";
      output.write(`[${event.taskId}] ${event.type}${rawType}\n`);
    }
  };
}

