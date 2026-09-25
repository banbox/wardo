import { z } from "zod";
import { LlmRegistry } from "./llm.js";
import type { WorkflowSpec } from "./types.js";

export const PlanSchema = z.object({
  objective: z.string().min(1),
  tasks: z.array(z.object({
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
    dependsOn: z.array(z.string()).default([]),
    goal: z.string().min(1),
    acceptance: z.string().min(1),
    providerHint: z.enum(["codex", "claude"]).optional(),
    expectedArtifacts: z.array(z.string()).default([]),
  })).min(1),
});

export async function planWorkflow(prompt: string, registry: LlmRegistry, signal?: AbortSignal): Promise<WorkflowSpec> {
  const result = await registry.generate({
    role: "planner",
    prompt: [
      "把下面的用户目标拆分成可执行的任务 DAG。",
      "每个任务只负责一个清晰的子目标，填写可验证的 acceptance。",
      "任务之间通过 dependsOn 传递依赖；没有依赖的任务可以并发。",
      "只输出符合 schema 的 JSON，不要修改工作区。",
      `用户目标：\n${prompt}`,
    ].join("\n\n"),
    schema: PlanSchema,
    signal,
  });
  const plan = result.object as z.infer<typeof PlanSchema>;
  return {
    id: "planned",
    objective: plan.objective,
    tasks: plan.tasks.map((task) => ({
      id: task.id,
      dependsOn: task.dependsOn,
      goal: task.goal,
      acceptance: task.acceptance,
      ...(task.providerHint ? { provider: task.providerHint } : {}),
    })),
  };
}
