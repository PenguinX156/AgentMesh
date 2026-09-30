#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type HarnessName } from './harness.js';
import { Runtime } from './runtime.js';
import { installIntegrations } from './install.js';
import { serveMcp } from './mcp.js';
import { doctor } from './doctor.js';
import { collaboratePlan } from './planning.js';
import { githubRepoName, initializeProject } from './onboarding.js';
import { planPath, readPlan } from './config.js';
import { runSync } from './process.js';

const args = process.argv.slice(2);
const command = args.shift() ?? 'help';
function option(name: string, fallback?: string) {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const value = args[i + 1];
  if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`);
  return value;
}
function output(value: unknown) { process.stdout.write(JSON.stringify(value, null, 2) + '\n'); }
function usage() { console.log('agentmesh setup [--repo URL] [--root PATH] [--agents codex,cursor,gemini]|init [--repo URL] [--root PATH] [--agents codex,cursor,gemini]|plan|install-integrations|doctor|start [--manual]|status|agents|phase|checkpoint|review|fix|integrate|revise-plan|advance|resume|recover|mcp'); }
async function main() {
  const remote = command === 'init' || command === 'setup' ? option('repo') : undefined;
  const root = resolve(option('root', remote ? join(process.cwd(), githubRepoName(remote)) : process.env.AGENTMESH_ROOT ?? process.cwd())!);
  if (command === 'help') return usage();
  if (command === 'mcp') return serveMcp(option('root') ?? process.env.AGENTMESH_ROOT, option('agent') ?? process.env.AGENTMESH_AGENT_ID);
  if (command === 'init' || command === 'setup') {
    const names = (option('agents', 'codex') ?? 'codex').split(',') as HarnessName[];
    const result = command === 'setup' && existsSync(planPath(root)) ? { root, plan: readPlan(root), existing: true } : await initializeProject(root, names, remote, option('type'));
    const integrations = command === 'setup' ? installIntegrations(root, fileURLToPath(import.meta.url)) : undefined;
    output({ ...result, ...(integrations ? { integrations } : {}), next: command === 'setup'
      ? 'Review and commit the plan, verify MCP tools in each harness, then start --manual or start'
      : 'Review validation commands, commit the plan, run install-integrations, then start --manual or start' });
    return;
  }
  if (command === 'doctor') return output(doctor(root));
  if (command === 'plan') return output(await collaboratePlan(root));
  if (command === 'install-integrations') return output(installIntegrations(root, fileURLToPath(import.meta.url)));
  const runtime = new Runtime(root);
  try {
    switch (command) {
      case 'start': {
        if (args.includes('--manual')) {
          const phase = runtime.begin();
          output({ mode: 'manual', phase, agents: runtime.state.agents().map(agent => ({ id: agent.id, harness: agent.harness, worktree: agent.worktree, tasks: runtime.getTask(agent.id) })), next: 'Open each worktree in its harness app and use AgentMesh MCP tools to coordinate work and submit checkpoints' });
          break;
        }
        const controller = new AbortController();
        process.once('SIGINT', () => controller.abort());
        output(await runtime.runPhase(controller.signal));
        break;
      }
      case 'resume': {
        if (runtime.state.phase(runtime.current().id)?.status === 'failed') runtime.recover();
        output(await runtime.runPhase());
        break;
      }
      case 'status': output(runtime.status()); break;
      case 'agents': output(runtime.state.agents()); break;
      case 'phase': output({ plan: runtime.current(), state: runtime.state.phase(runtime.current().id) }); break;
      case 'checkpoint': {
        const agent = option('agent'), task = option('task'), summary = option('summary');
        if (!agent || !task || !summary) throw new Error('checkpoint requires --agent, --task, and --summary');
        if (runSync('git', ['branch', '--show-current'], process.cwd()) !== `agentmesh/${runtime.current().id}/${agent}`) throw new Error('Run checkpoint from the named agent worktree');
        output(runtime.submitCheckpoint(agent, task, { summary })); break;
      }
      case 'review': {
        if (args.includes('--auto')) { output(await runtime.reviewAll()); break; }
        const reviewer = option('reviewer'), subject = option('subject'), verdict = option('verdict'), body = option('body', 'Reviewed changes');
        if (!reviewer || !subject || !['approve', 'changes_requested'].includes(verdict ?? '')) throw new Error('review requires --reviewer, --subject, --verdict');
        if (runSync('git', ['branch', '--show-current'], process.cwd()) !== `agentmesh/${runtime.current().id}/${reviewer}`) throw new Error('Run review from the named reviewer worktree, or use its MCP tool');
        runtime.submitReview(reviewer, subject, verdict as 'approve' | 'changes_requested', body!); output({ submitted: true }); break;
      }
      case 'fix': { const agent = option('agent'); if (!agent) throw new Error('fix requires --agent'); output(await runtime.fixAgent(agent)); break; }
      case 'integrate': output(await runtime.integrate()); break;
      case 'recover': output(runtime.recover()); break;
      case 'revise-plan': { const file = option('file'); if (!file) throw new Error('revise-plan requires --file'); output(runtime.revisePlan(JSON.parse(readFileSync(resolve(file), 'utf8')))); break; }
      case 'advance': output(runtime.advance()); break;
      default: usage(); process.exitCode = 2;
    }
  } finally { runtime.close(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
