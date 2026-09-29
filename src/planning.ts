import { readPlan, validatePlan, writePlan, type Plan } from './config.js';
import { Git } from './git.js';
import { State } from './state.js';
import { adapters } from './harness.js';

function parsePlan(text: string): Plan {
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Planning agent did not return JSON');
  return validatePlan(JSON.parse(text.slice(start, end + 1)));
}

export async function collaboratePlan(root: string) {
  const original = readPlan(root);
  const git = new Git(root);
  const state = new State(root);
  try { if (state.phase(original.currentPhase)) throw new Error('Current phase has already started'); }
  finally { state.close(); }
  git.requireClean();
  const foundation = git.head();
  const phase = `planning-${foundation.slice(0, 10)}`;
  for (const agent of original.agents) if (!adapters[agent.harness].detect().installed) throw new Error(`${agent.harness} CLI is unavailable for planning`);
  const worktrees: { agent: Plan['agents'][number]; branch: string; path: string }[] = [];
  const cleanup: { agent: string; error?: string }[] = [];
  try {
    for (const agent of original.agents) worktrees.push({ agent, ...git.createWorktree(phase, agent.id, foundation) });
    const proposals = await Promise.all(worktrees.map(async ({ agent, path }) => {
      const prompt = [
        `Inspect this repository in read-only mode for an AgentMesh collaboration plan.`,
        `You are ${agent.id} (${agent.harness}), role ${agent.role}.`,
        `Starting profile: ${JSON.stringify(original).slice(0, 20000)}.`,
        `Give a compact proposal for project type, architecture, phases, ownership, dependencies, frozen contracts, review and validation commands.`,
        `Do not modify files. Limit response to 4000 characters.`
      ].join('\n');
      const response = await adapters[agent.harness].invoke(prompt, path, agent.model, undefined, undefined, { root, agentId: agent.id }, 'review');
      return { agent: agent.id, text: response.text.slice(0, 4000) };
    }));
    const lead = worktrees[0]!;
    const prompt = [
      'Synthesize a single AgentMesh Collaboration Plan from these independent proposals.',
      'Return only a JSON object that follows the provided starting plan structure.',
      'Preserve the exact agents and harness names. Use concrete project validation commands as argument arrays.',
      'Keep phases and tasks bounded, dependencies acyclic, and shared contracts as repository-relative paths.',
      `Starting plan: ${JSON.stringify(original).slice(0, 20000)}`,
      `Proposals: ${JSON.stringify(proposals).slice(0, 20000)}`
    ].join('\n');
    const response = await adapters[lead.agent.harness].invoke(prompt, lead.path, lead.agent.model, undefined, undefined, { root, agentId: lead.agent.id }, 'review');
    const plan = parsePlan(response.text);
    const initial = original.agents.map(a => `${a.id}:${a.harness}`).sort().join(',');
    const proposed = plan.agents.map(a => `${a.id}:${a.harness}`).sort().join(',');
    if (initial !== proposed) throw new Error('Planning agent changed participating agents');
    if (plan.currentPhase !== plan.phases[0]?.id) throw new Error('Current phase must be the first planned phase');
    if (plan.phases.some(p => !p.validation.length)) throw new Error('Every phase needs project validation commands');
    writePlan(root, plan);
    return { plan, proposals, cleanup };
  } finally {
    for (const { agent } of worktrees) {
      try { git.removeWorktree(phase, agent.id); cleanup.push({ agent: agent.id }); }
      catch (error) { cleanup.push({ agent: agent.id, error: String(error) }); }
    }
  }
}
