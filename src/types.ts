export type ProviderName = "codex" | "claude";
export type LlmProviderName = "openai" | "anthropic" | "openai-compatible" | "local";

export type TaskStatus =
  | "pending"
  | "ready"
  | "running"
  | "awaiting_judge"
  | "retry_wait"
  | "paused"
  | "succeeded"
  | "partial"
  | "failed"
  | "blocked"
  | "cancelled"
  | "unknown";

export interface TaskSpec {
  id: string;
  parentId?: string;
  dependsOn?: string[];
  goal: string;
  acceptance: string;
  provider?: ProviderName | "auto";
  model?: string;
  maxAttempts?: number;
  children?: TaskSpec[];
  contextPolicy?: "summary" | "artifacts" | "full";
}

export interface WorkflowSpec {
  id: string;
  objective: string;
  tasks: TaskSpec[];
  maxConcurrency?: number;
  failFast?: boolean;
}

export interface WardoEvent {
  schemaVersion: 1;
  runId: string;
  taskId: string;
  attemptId: string;
  seq: number;
  ts: string;
  type: string;
  provider?: ProviderName | "llm";
  payload?: unknown;
}

export interface TaskResult {
  status: TaskStatus;
  text: string;
  structured?: unknown;
  provider?: ProviderName;
  sessionId?: string;
  checkpoint?: { provider: ProviderName; sessionId: string; seq?: number; updatedAt: string };
  usage?: Record<string, unknown>;
  error?: string;
  attempt: number;
}

export interface AgentSession {
  provider: ProviderName;
  sessionId: string;
  model?: string;
  cwd: string;
}

export interface AgentInput {
  prompt: string;
  model?: string;
  outputSchema?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface AgentEvent {
  type:
    | "session_started"
    | "turn_started"
    | "text_delta"
    | "reasoning"
    | "tool_call"
    | "file_change"
    | "turn_completed"
    | "error"
    | "status";
  provider: ProviderName;
  rawType: string;
  text?: string;
  payload?: unknown;
}

export interface AgentAdapter {
  start(input: AgentInput & { cwd: string; additionalDirectories?: string[] }): Promise<AgentSession>;
  resume(session: AgentSession, input: AgentInput): Promise<AgentSession>;
  stream(session: AgentSession, input: AgentInput): AsyncIterable<AgentEvent>;
  cancel(session: AgentSession, reason?: string): Promise<void>;
  fork?(session: AgentSession, at?: string): Promise<AgentSession>;
}

export interface RetryPolicy {
  delaysMs: number[];
  maxAttempts: number;
}

export interface ProviderConfig {
  type: LlmProviderName;
  name?: string;
  apiKey?: string;
  baseUrl?: string;
  models?: string[];
  headers?: Record<string, string>;
}

export interface WardoConfig {
  workspace?: string;
  maxConcurrency: number;
  providerConcurrency?: Partial<Record<ProviderName, number>>;
  retry: RetryPolicy;
  providers: Record<string, ProviderConfig>;
  /** Provider names in configuration order. Older object configs derive this from object insertion order. */
  providerOrder?: string[];
  providerHealth?: {
    cooldownMs: number;
    probeProbability: number;
  };
  modelPreferences: string[];
  agentDefaults: {
    codex?: { model?: string; sandboxMode?: string; approvalPolicy?: string };
    claude?: { model?: string; fallbackModel?: string; permissionMode?: string };
  };
  judge?: { provider?: string; model?: string; maxRetries?: number };
}

export interface RunOptions {
  workspace?: string;
  runId?: string;
  resume?: boolean;
  maxConcurrency?: number;
  signal?: AbortSignal;
}
