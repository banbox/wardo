import { appendFile, mkdir, readFile, rename, writeFile, open, rm } from "node:fs/promises";
import { join } from "node:path";
import type { AgentSession, WardoEvent } from "./types.js";

export class WardoStore {
  readonly root: string;

  constructor(workspace: string) {
    this.root = join(workspace, ".wardo");
  }

  async init(prompt?: string): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await mkdir(join(this.root, "tasks"), { recursive: true });
    await mkdir(join(this.root, "sessions"), { recursive: true });
    await mkdir(join(this.root, "artifacts"), { recursive: true });
    await mkdir(join(this.root, "summaries"), { recursive: true });
    await mkdir(join(this.root, "scripts"), { recursive: true });
    if (prompt !== undefined) await this.atomicWrite("prompt.md", prompt);
  }

  private path(relative: string): string {
    return join(this.root, relative);
  }

  async atomicWrite(relative: string, value: string | object): Promise<void> {
    const target = this.path(relative);
    await mkdir(join(target, ".."), { recursive: true });
    const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
    const content = typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`;
    await writeFile(temp, content, "utf8");
    await rename(temp, target);
  }

  async readJson<T>(relative: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(this.path(relative), "utf8")) as T;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code === "ENOENT") return undefined;
      throw error;
    }
  }

  async appendEvent(event: WardoEvent): Promise<void> {
    const relative = join("tasks", event.taskId, event.attemptId, "events.jsonl");
    const target = this.path(relative);
    await mkdir(join(target, ".."), { recursive: true });
    await appendFile(target, `${JSON.stringify(event)}\n`, "utf8");
  }

  async saveTaskState(taskId: string, state: object): Promise<void> {
    await this.atomicWrite(join("tasks", taskId, "state.json"), state);
  }

  async saveAttempt(taskId: string, attemptId: string, result: object, output?: string): Promise<void> {
    const dir = join("tasks", taskId, attemptId);
    await this.atomicWrite(join(dir, "result.json"), result);
    if (output !== undefined) await this.atomicWrite(join(dir, "output.md"), output);
  }

  async saveCheckpoint(taskId: string, attemptId: string, checkpoint: object): Promise<void> {
    await this.atomicWrite(join("tasks", taskId, attemptId, "checkpoint.json"), checkpoint);
  }

  async saveSession(session: AgentSession): Promise<void> {
    await this.atomicWrite(join("sessions", `${session.provider}-${session.sessionId}.json`), {
      schemaVersion: 1,
      ...session,
      updatedAt: new Date().toISOString(),
    });
  }

  async readSession(provider: AgentSession["provider"], sessionId: string): Promise<AgentSession | undefined> {
    return this.readJson<AgentSession>(join("sessions", `${provider}-${sessionId}.json`));
  }

  async lock(): Promise<() => Promise<void>> {
    await mkdir(this.path("locks"), { recursive: true });
    const handle = await open(this.path("locks/run.lock"), "wx");
    await handle.writeFile(`${process.pid}\n`, "utf8");
    return async () => {
      await handle.close();
      await rm(this.path("locks/run.lock"), { force: true });
    };
  }
}

