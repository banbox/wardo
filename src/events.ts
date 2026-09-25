import type { AgentEvent, ProviderName, WardoEvent } from "./types.js";
import { WardoStore } from "./store.js";

export type EventListener = (event: WardoEvent) => void | Promise<void>;

export class EventBus {
  private readonly listeners = new Set<EventListener>();
  private readonly sequences = new Map<string, number>();

  constructor(private readonly store: WardoStore) {}

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async emit(input: Omit<WardoEvent, "schemaVersion" | "seq" | "ts"> & { ts?: string }): Promise<WardoEvent> {
    const key = `${input.runId}:${input.taskId}:${input.attemptId}`;
    const seq = (this.sequences.get(key) ?? 0) + 1;
    this.sequences.set(key, seq);
    const event: WardoEvent = { ...input, schemaVersion: 1, seq, ts: input.ts ?? new Date().toISOString() };
    await this.store.appendEvent(event);
    await Promise.all([...this.listeners].map((listener) => listener(event)));
    return event;
  }
}

export function normalizeAgentEvent(event: AgentEvent, runId: string, taskId: string, attemptId: string): Omit<WardoEvent, "schemaVersion" | "seq" | "ts"> {
  return { runId, taskId, attemptId, type: event.type, provider: event.provider, payload: { rawType: event.rawType, text: event.text, value: event.payload } };
}

export function providerEventType(provider: ProviderName, raw: unknown): AgentEvent["type"] {
  const type = typeof raw === "object" && raw && "type" in raw ? String(raw.type) : "unknown";
  if (type.includes("error") || type.includes("failed")) return "error";
  if (type.includes("completed") || type === "result") return "turn_completed";
  if (type.includes("started") || type === "init") return type === "init" ? "session_started" : "turn_started";
  if (type.includes("file")) return "file_change";
  if (type.includes("reason")) return "reasoning";
  if (type.includes("tool") || type.includes("command")) return "tool_call";
  return "status";
}

