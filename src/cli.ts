#!/usr/bin/env node
import { existsSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultPlan, inferProjectType, planPath, readPlan, writePlan } from './config.js';
import { adapters, type HarnessName } from './harness.js';
import { Runtime } from './runtime.js';
import { Git } from './git.js';
import { State } from './state.js';
import { installIntegrations } from './install.js';
import { serveMcp } from './mcp.js';
import { runSync } from './process.js';
import { doctor } from './doctor.js';
import { collaboratePlan } from './planning.js';

const args = process.argv.slice(2);
const command = args.shift() ?? 'help';
function option(name: string, fallback?: string) { const i = args.indexOf(`--${name}`); return i < 0 ? fallback : args[i + 1]; }
function output(value: unknown) { process.stdout.write(JSON.stringify(value, null, 2) + '\n'); }
function usage() { console.log('agentmesh init|plan|install-integrations|doctor|start|status|agents|phase|checkpoint|review|fix|integrate|advance|resume|recover|mcp'); }
const root = resolve(option('root', process.env.AGENTMESH_ROOT ?? process.cwd())!);
async function main() {
  if (command === 'help') return usage();
  if (command === 'mcp') return serveMcp(root, option('agent') ?? process.env.AGENTMESH_AGENT_ID ?? '');
  if (command === 'init') {
    if (existsSync(planPath(root))) throw new Error('Collaboration plan already exists');
    if (!existsSync(join(root, '.git'))) runSync('git', ['init'], root);
    const names = (option('agents', 'codex') ?? 'codex').split(',') as HarnessName[];
    for (const name of names) if (!adapters[name]) throw new Error(`Unknown harness: ${name}`);
    const counts = new Map<string, number>();
    const agents = names.map(name => { const n = (counts.get(name) ?? 0) + 1; counts.set(name, n); return { id: n === 1 ? name : `${name}-${n}`, harness: name, role: 'developer' }; });
    const plan = defaultPlan(option('type', inferProjectType(root))!, agents);
    writePlan(root, plan);
    writeFileSync(join(root, '.agentmesh', '.gitignore'), 'state.sqlite*\nworktrees/\nintegration/\n');
    const state = new State(root); state.close();
    output({ plan: planPath(root), agents, next: 'Edit the plan, commit it, then run agentmesh start' });
    return;
  }
  if (command === 'doctor') return output(doctor(root));
  if (command === 'plan') return output(await collaboratePlan(root));
  if (command === 'install-integrations') return output(installIntegrations(root, fileURLToPath(import.meta.url)));
  const runtime = new Runtime(root);
  try {
    switch (command) {
      case 'start': {
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
        output(runtime.submitCheckpoint(agent, task, { summary })); break;
      }
      case 'review': {
        if (args.includes('--auto')) { output(await runtime.reviewAll()); break; }
        const reviewer = option('reviewer'), subject = option('subject'), verdict = option('verdict'), body = option('body', 'Reviewed changes');
        if (!reviewer || !subject || !['approve', 'changes_requested'].includes(verdict ?? '')) throw new Error('review requires --reviewer, --subject, --verdict');
        runtime.submitReview(reviewer, subject, verdict as 'approve' | 'changes_requested', body!); output({ submitted: true }); break;
      }
      case 'fix': { const agent = option('agent'); if (!agent) throw new Error('fix requires --agent'); output(await runtime.fixAgent(agent)); break; }
      case 'integrate': output(await runtime.integrate()); break;
      case 'recover': output(runtime.recover()); break;
      case 'advance': output(runtime.advance()); break;
      default: usage(); process.exitCode = 2;
    }
  } finally { runtime.close(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
