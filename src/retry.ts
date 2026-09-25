import type { RetryPolicy } from "./types.js";

export type ErrorClass = "network" | "rate_limit" | "server" | "auth" | "invalid" | "permission" | "unknown";

export interface ClassifiedError {
  class: ErrorClass;
  retryable: boolean;
  status?: number;
  message: string;
}

export function classifyError(error: unknown): ClassifiedError {
  const message = error instanceof Error ? error.message : String(error);
  const status = typeof error === "object" && error
    ? "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode
      : "status" in error && typeof error.status === "number" ? error.status : undefined
    : undefined;
  const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
  if (status === 401 || status === 403 || /auth|api.?key|unauthori[sz]ed|forbidden/i.test(message)) return { class: "auth", retryable: false, status, message };
  if (status === 429 || /rate.?limit|too many requests|overloaded/i.test(message)) return { class: "rate_limit", retryable: true, status, message };
  if (status !== undefined && status >= 500 || /503|server error|temporarily unavailable/i.test(message)) return { class: "server", retryable: true, status, message };
  if (/timeout|network|fetch failed|econn|enotfound|socket|connection/i.test(`${code} ${message}`)) return { class: "network", retryable: true, status, message };
  if (status === 400 || status === 422 || /invalid request|schema/i.test(message)) return { class: "invalid", retryable: false, status, message };
  if (/permission|sandbox|access denied/i.test(message)) return { class: "permission", retryable: false, status, message };
  return { class: "unknown", retryable: false, status, message };
}

export function retryDelay(policy: RetryPolicy, failedAttempt: number, retryAfterMs?: number): number | undefined {
  if (retryAfterMs !== undefined && retryAfterMs >= 0) return retryAfterMs;
  return policy.delaysMs[failedAttempt - 1];
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("Aborted"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason ?? new Error("Aborted")); }, { once: true });
  });
}
