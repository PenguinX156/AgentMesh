import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultPlan, writePlan } from '../dist/src/config.js';
import { Runtime } from '../dist/src/runtime.js';
import { runSync } from '../dist/src/process.js';

const root = mkdtempSync(join(tmpdir(), 'agentmesh-live-workflow-'));
let succeeded = false;
try {
  runSync('git', ['init'], root);
  runSync('git', ['config', 'user.email', 'smoke@example.com'], root);
  runSync('git', ['config', 'user.name', 'AgentMesh Smoke'], root);
  writeFileSync(join(root, '.gitignore'), '.agentmesh/state.sqlite*\n.agentmesh/worktrees/\n.agentmesh/integration/\n');
  writeFileSync(join(root, 'README.md'), '# AgentMesh live fixture\n');
  const plan = defaultPlan('cli', [{ id: 'codex', harness: 'codex', role: 'developer' }]);
  plan.phases = [plan.phases[0]];
  plan.phases[0].tasks[0].instructions = 'Create hello.txt containing exactly hello followed by a newline. Commit the file.';
  plan.phases[0].validation = [['node', '-e', "const fs=require('node:fs'); if(!['68656c6c6f0a','68656c6c6f0d0a'].includes(fs.readFileSync('hello.txt').toString('hex'))) process.exit(1)"]];
  plan.integration.requireReviews = false;
  writePlan(root, plan);
  runSync('git', ['add', '.'], root);
  runSync('git', ['commit', '-m', 'base'], root);
  const runtime = new Runtime(root);
  try {
    const result = await runtime.runPhase();
    if (result.status.phase?.status !== 'complete') throw new Error(`Phase incomplete: ${JSON.stringify(result)}`);
    const content = runSync('git', ['show', 'agentmesh/integration:hello.txt'], root);
    if (content !== 'hello') throw new Error(`Wrong integration content: ${content}`);
    console.log(JSON.stringify({ ok: true, phase: result.status.phase?.status, session: result.status.agents[0]?.session_id, commit: result.integration?.commit }));
    succeeded = true;
  } finally { runtime.close(); }
} finally {
  if (succeeded) rmSync(root, { recursive: true, force: true });
  else console.error(`Failed live fixture retained at ${root}`);
}
