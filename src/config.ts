import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

const identifier = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);
export const taskSchema = z.object({ id: identifier, title: z.string().min(1), owner: identifier, dependsOn: z.array(identifier).default([]), instructions: z.string().default('') });
export const phaseSchema = z.object({ id: identifier, title: z.string().min(1), tasks: z.array(taskSchema).min(1), contracts: z.array(z.string()).default([]), validation: z.array(z.array(z.string()).min(1)).default([]) });
export const planSchema = z.object({
  version: z.literal(1), projectType: z.string(), intensity: z.enum(['low', 'normal', 'high']).default('normal'),
  agents: z.array(z.object({ id: identifier, harness: z.enum(['codex', 'cursor', 'gemini', 'antigravity']), role: z.string().default('developer') }).strict()).min(1),
  phases: z.array(phaseSchema).min(1), currentPhase: identifier, completed: z.boolean().default(false),
  integration: z.object({ branch: z.string().default('agentmesh/integration'), requireReviews: z.boolean().default(true) }).default({ branch: 'agentmesh/integration', requireReviews: true })
});
export type Plan = z.infer<typeof planSchema>;

export function planPath(root: string) { return join(root, '.agentmesh', 'collaboration-plan.json'); }
export function validatePlan(input: unknown): Plan {
  const plan = planSchema.parse(input);
  const agentIds = new Set(plan.agents.map(a => a.id));
  if (agentIds.size !== plan.agents.length) throw new Error('Duplicate agent IDs');
  if (new Set(plan.phases.map(p => p.id)).size !== plan.phases.length) throw new Error('Duplicate phase IDs');
  if (!plan.phases.some(p => p.id === plan.currentPhase)) throw new Error('Current phase is not defined');
  for (const phase of plan.phases) {
    const ids = new Set(phase.tasks.map(t => t.id));
    if (ids.size !== phase.tasks.length) throw new Error(`Duplicate tasks in ${phase.id}`);
    for (const task of phase.tasks) {
      if (!agentIds.has(task.owner)) throw new Error(`Unknown task owner ${task.owner}`);
      if (task.dependsOn.some(d => !ids.has(d))) throw new Error(`Unknown task dependency in ${task.id}`);
    }
    const visiting = new Set<string>(), visited = new Set<string>();
    const visit = (id: string) => {
      if (visiting.has(id)) throw new Error(`Task dependency cycle in ${phase.id}`);
      if (visited.has(id)) return;
      visiting.add(id);
      for (const dep of phase.tasks.find(t => t.id === id)!.dependsOn) visit(dep);
      visiting.delete(id); visited.add(id);
    };
    for (const task of phase.tasks) visit(task.id);
  }
  return plan;
}
export function readPlan(root: string): Plan { return validatePlan(JSON.parse(readFileSync(planPath(root), 'utf8'))); }
export function writePlan(root: string, plan: Plan) {
  const validated = validatePlan(plan);
  mkdirSync(join(root, '.agentmesh'), { recursive: true });
  writeFileSync(planPath(root), JSON.stringify(validated, null, 2) + '\n');
}
export function defaultPlan(projectType: string, agents: Plan['agents']): Plan {
  const profiles: Record<string, string[]> = {
    'web-app': ['Foundation and interfaces', 'Implementation', 'Browser validation'],
    game: ['Gameplay design', 'Implementation', 'Playtest'], plugin: ['Protocol design', 'Implementation', 'Compatibility validation'],
    cli: ['Command contracts', 'Implementation', 'Packaging validation'], 'backend-service': ['API contracts', 'Implementation', 'Integration validation'],
    library: ['Public API', 'Implementation', 'Compatibility validation'], 'mobile-app': ['Interface plan', 'Implementation', 'Device validation'],
    'research-prototype': ['Research plan', 'Experiment', 'Evaluation']
  };
  const titles = profiles[projectType] ?? profiles.cli!;
  return planSchema.parse({ version: 1, projectType, intensity: 'normal', agents,
    phases: titles.map((title, i) => ({ id: `phase-${i + 1}`, title, tasks: agents.map(a => ({ id: `${a.id}-work`, title: `${a.role} work`, owner: a.id, instructions: `Complete ${title.toLowerCase()} responsibilities.` })), contracts: [], validation: [] })),
    currentPhase: 'phase-1', integration: { branch: 'agentmesh/integration', requireReviews: agents.length > 1 } });
}
export function inferProjectType(root: string): string {
  if (existsSync(join(root, 'android')) || existsSync(join(root, 'ios'))) return 'mobile-app';
  if (['vite.config.ts', 'vite.config.js', 'next.config.js', 'next.config.mjs', 'next.config.ts'].some(file => existsSync(join(root, file)))) return 'web-app';
  if (existsSync(join(root, 'plugin.json'))) return 'plugin';
  return 'cli';
}
