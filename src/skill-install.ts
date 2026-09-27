import { cp, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentName } from "./environment.js";
import { detectAgentEnvironment } from "./environment.js";

export interface SkillInstallResult {
  agent: AgentName;
  target: string;
}

function packageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

export async function installSkill(agent?: AgentName, source = join(packageRoot(), "skills", "wardo")): Promise<SkillInstallResult[]> {
  const environment = await detectAgentEnvironment();
  const targets: AgentName[] = agent
    ? [agent]
    : (["codex", "claude"] as AgentName[]).filter((item) => environment.installed[item]);
  if (!targets.length) throw new Error("Neither codex nor claude was found; install one agent before installing the wardo skill.");
  const results: SkillInstallResult[] = [];
  for (const item of targets) {
    const target = join(homedir(), item === "codex" ? ".codex/skills/wardo" : ".claude/skills/wardo");
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target, { recursive: true, force: true });
    results.push({ agent: item, target });
  }
  return results;
}

