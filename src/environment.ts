import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export type AgentName = "codex" | "claude";

export interface AgentEnvironment {
  active?: AgentName;
  installed: Record<AgentName, boolean>;
  versions: Partial<Record<AgentName, string>>;
  detectedBy: string[];
  skillDirectory?: string;
}

async function executable(name: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const paths = (env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const directory of paths) {
    try {
      await access(join(directory, name));
      return true;
    } catch {
      // Continue through PATH entries.
    }
  }
  return false;
}

async function version(name: AgentName, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  try {
    const result = await execFileAsync(name, ["--version"], { timeout: 3_000, env });
    return `${result.stdout}${result.stderr}`.trim().split("\n")[0];
  } catch {
    return undefined;
  }
}

async function parentCommand(): Promise<string> {
  try {
    return await readFile(`/proc/${process.ppid}/cmdline`, "utf8");
  } catch {
    return "";
  }
}

export async function detectAgentEnvironment(env: NodeJS.ProcessEnv = process.env): Promise<AgentEnvironment> {
  const [codexInstalled, claudeInstalled, codexVersion, claudeVersion, parent] = await Promise.all([
    executable("codex", env),
    executable("claude", env),
    version("codex", env),
    version("claude", env),
    parentCommand(),
  ]);
  const detectedBy: string[] = [];
  let active: AgentName | undefined;
  const explicit = env.WARDO_ACTIVE_AGENT === "codex" || env.WARDO_ACTIVE_AGENT === "claude" ? env.WARDO_ACTIVE_AGENT : undefined;
  if (explicit) {
    active = explicit;
    detectedBy.push("WARDO_ACTIVE_AGENT");
  } else if (env.CODEX_THREAD_ID || env.CODEX_SESSION_ID || env.CODEX_VERSION || env.CODEX_CI) {
    active = "codex";
    detectedBy.push("Codex environment variables");
  } else if (env.CLAUDE_CODE || env.CLAUDE_CODE_VERSION || env.CLAUDE_CODE_ENTRYPOINT) {
    active = "claude";
    detectedBy.push("Claude Code environment variables");
  } else if (/claude/i.test(parent)) {
    active = "claude";
    detectedBy.push("parent process");
  } else if (/codex/i.test(parent)) {
    active = "codex";
    detectedBy.push("parent process");
  } else if (codexInstalled !== claudeInstalled) {
    active = codexInstalled ? "codex" : "claude";
    detectedBy.push("only installed agent");
  }
  return {
    ...(active ? { active } : {}),
    installed: { codex: codexInstalled, claude: claudeInstalled },
    versions: { ...(codexVersion ? { codex: codexVersion } : {}), ...(claudeVersion ? { claude: claudeVersion } : {}) },
    detectedBy,
    ...(active ? { skillDirectory: join(homedir(), active === "codex" ? ".codex/skills" : ".claude/skills") } : {}),
  };
}
