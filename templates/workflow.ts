import { execute } from "wardo";

await execute({
  prompt: "把用户目标写在这里",
  workspace: process.cwd(),
  maxConcurrency: 3,
  resume: true,
});

