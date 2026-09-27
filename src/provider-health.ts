import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface ProviderHealthRecord {
  failures: number;
  unavailableUntil?: number;
  lastError?: string;
  lastFailureAt?: number;
  lastSuccessAt?: number;
}

export type HealthFile = Record<string, ProviderHealthRecord>;

/** Small durable circuit breaker used by the LLM registry. */
export class ProviderHealth {
  private state: HealthFile = {};
  private loaded = false;
  private loading?: Promise<void>;

  constructor(
    private readonly filePath: string | undefined,
    private readonly cooldownMs = 300_000,
    private readonly probeProbability = 0.1,
    private readonly random: () => number = Math.random,
  ) {}

  private async load(): Promise<void> {
    if (this.loaded) return;
    if (!this.loading) {
      this.loading = (async () => {
        if (this.filePath) {
          try {
            const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
            if (parsed && typeof parsed === "object") this.state = parsed as HealthFile;
          } catch (error) {
            const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
            if (code !== "ENOENT") throw error;
          }
        }
        this.loaded = true;
      })();
    }
    await this.loading;
  }

  private async save(): Promise<void> {
    if (!this.filePath) return;
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
  }

  async available(name: string, now = Date.now()): Promise<boolean> {
    await this.load();
    const record = this.state[name];
    if (!record?.unavailableUntil || record.unavailableUntil <= now) return true;
    return this.random() < this.probeProbability;
  }

  async failure(name: string, error: unknown, now = Date.now()): Promise<void> {
    await this.load();
    const previous = this.state[name];
    this.state[name] = {
      failures: (previous?.failures ?? 0) + 1,
      unavailableUntil: now + this.cooldownMs,
      lastFailureAt: now,
      lastError: error instanceof Error ? error.message : String(error),
    };
    await this.save();
  }

  async success(name: string, now = Date.now()): Promise<void> {
    await this.load();
    this.state[name] = { failures: 0, lastSuccessAt: now };
    await this.save();
  }

  async snapshot(): Promise<HealthFile> {
    await this.load();
    return structuredClone(this.state);
  }
}

export function providerHealthPath(workspace?: string): string | undefined {
  return workspace ? join(workspace, ".wardo", "provider-health.json") : undefined;
}
