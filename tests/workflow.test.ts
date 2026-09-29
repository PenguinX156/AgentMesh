import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { defaultPlan, readPlan, writePlan } from '../src/config.js';
import { Runtime } from '../src/runtime.js';
import { runSync } from '../src/process.js';

test('two isolated agents checkpoint, review, and integrate from one foundation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentmesh-test-'));
  try {
    runSync('git', ['init'], root);
    runSync('git', ['config', 'user.email', 'test@example.com'], root);
    runSync('git', ['config', 'user.name', 'Test'], root);
    writeFileSync(join(root, '.gitignore'), '.agentmesh/state.sqlite*\n.agentmesh/worktrees/\n.agentmesh/integration/\n');
    writeFileSync(join(root, 'README.md'), '# Fixture\n');
    const plan = defaultPlan('cli', [{ id: 'codex', harness: 'codex', role: 'code' }, { id: 'gemini', harness: 'gemini', role: 'docs' }]);
    plan.phases[0]!.validation = [['node', '--version']];
    plan.phases[0]!.contracts = ['README.md'];
    writePlan(root, plan);
    runSync('git', ['add', '.'], root);
    runSync('git', ['commit', '-m', 'base'], root);
    const runtime = new Runtime(root);
    try {
      const phase = runtime.begin();
      assert.equal(phase.status, 'working');
      const agents = runtime.state.agents();
      assert.equal(agents.length, 2);
      assert.notEqual(agents[0]!.worktree, agents[1]!.worktree);
      const cli = resolve(fileURLToPath(import.meta.url), '..', '..', 'src', 'cli.js');
      const client = new Client({ name: 'agentmesh-worktree-test', version: '1.0.0' });
      const transport = new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp'], cwd: agents[0]!.worktree, env: { ...process.env, AGENTMESH_ROOT: '', AGENTMESH_AGENT_ID: '' } as Record<string, string> });
      try {
        await client.connect(transport);
        const response = await client.callTool({ name: 'get_project_context', arguments: {} });
        assert.equal(JSON.parse((response as { content: { text: string }[] }).content[0]!.text).agentId, 'codex');
      } finally { await client.close(); }
      for (const agent of agents) {
        writeFileSync(join(agent.worktree, `${agent.id}.txt`), agent.id);
        runSync('git', ['add', '.'], agent.worktree);
        runSync('git', ['commit', '-m', `work by ${agent.id}`], agent.worktree);
        runtime.submitCheckpoint(agent.id, `${agent.id}-work`, { summary: 'done' });
      }
      assert.equal(runtime.state.phase('phase-1')?.status, 'review');
      runtime.submitReview('codex', 'gemini', 'approve', 'looks good');
      runtime.submitReview('gemini', 'codex', 'approve', 'looks good');
      const result = await runtime.integrate();
      assert.ok(result.commit);
      assert.equal(runtime.state.phase('phase-1')?.status, 'complete');
      assert.equal(runSync('git', ['show', 'agentmesh/integration:codex.txt'], root), 'codex');
      assert.equal(runSync('git', ['show', 'agentmesh/integration:gemini.txt'], root), 'gemini');
      const revised = structuredClone(runtime.plan);
      revised.phases[1]!.title = 'Revised implementation phase';
      assert.equal(runtime.revisePlan(revised).changed, true);
      const advanced = runtime.advance();
      assert.equal(advanced.next, 'phase-2');
      assert.ok(advanced.cleanup.every(item => item.removed));
      assert.equal(readPlan(root).phases[1]!.title, 'Revised implementation phase');
    } finally { runtime.close(); }
    const nextRuntime = new Runtime(root);
    try {
      const next = nextRuntime.begin();
      assert.equal(next.id, 'phase-2');
      assert.equal(next.foundation, runSync('git', ['rev-parse', 'HEAD'], root));
      assert.equal(nextRuntime.state.agents().length, 2);
    } finally { nextRuntime.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('frozen contracts stop checkpoint submission', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentmesh-contract-'));
  try {
    runSync('git', ['init'], root);
    runSync('git', ['config', 'user.email', 'test@example.com'], root);
    runSync('git', ['config', 'user.name', 'Test'], root);
    writeFileSync(join(root, '.gitignore'), '.agentmesh/state.sqlite*\n.agentmesh/worktrees/\n.agentmesh/integration/\n');
    writeFileSync(join(root, 'README.md'), 'original');
    const plan = defaultPlan('cli', [{ id: 'codex', harness: 'codex', role: 'code' }]);
    plan.phases[0]!.contracts = ['README.md'];
    writePlan(root, plan);
    runSync('git', ['add', '.'], root); runSync('git', ['commit', '-m', 'base'], root);
    const runtime = new Runtime(root);
    try {
      runtime.begin();
      const path = runtime.state.agents()[0]!.worktree;
      writeFileSync(join(path, 'README.md'), 'changed');
      runSync('git', ['add', '.'], path); runSync('git', ['commit', '-m', 'bad'], path);
      assert.throws(() => runtime.submitCheckpoint('codex', 'codex-work', { summary: 'bad' }), /Frozen contract changed/);
    } finally { runtime.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('failed validation preserves integration history and reopens phase', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentmesh-recover-'));
  try {
    runSync('git', ['init'], root);
    runSync('git', ['config', 'user.email', 'test@example.com'], root);
    runSync('git', ['config', 'user.name', 'Test'], root);
    writeFileSync(join(root, '.gitignore'), '.agentmesh/state.sqlite*\n.agentmesh/worktrees/\n.agentmesh/integration/\n');
    writeFileSync(join(root, 'README.md'), 'fixture');
    const plan = defaultPlan('cli', [{ id: 'codex', harness: 'codex', role: 'code' }]);
    plan.phases[0]!.validation = [['node', '-e', 'console.log("FAIL_MARKER"); process.exit(1)']];
    writePlan(root, plan);
    runSync('git', ['add', '.'], root); runSync('git', ['commit', '-m', 'base'], root);
    const runtime = new Runtime(root);
    try {
      runtime.begin();
      const path = runtime.state.agents()[0]!.worktree;
      writeFileSync(join(path, 'new.txt'), 'work');
      runSync('git', ['add', '.'], path); runSync('git', ['commit', '-m', 'work'], path);
      runtime.submitCheckpoint('codex', 'codex-work', { summary: 'done' });
      await assert.rejects(runtime.integrate(), /failed/);
      const diagnostic = runtime.state.db.prepare("SELECT output FROM integrations WHERE phase_id=? ORDER BY id DESC LIMIT 1").get('phase-1') as { output: string };
      assert.match(diagnostic.output, /FAIL_MARKER/);
      assert.equal(runtime.state.phase('phase-1')?.status, 'failed');
      const recovered = runtime.recover();
      assert.ok(recovered.backup);
      assert.equal(runtime.state.phase('phase-1')?.status, 'working');
      assert.equal(runSync('git', ['rev-parse', 'HEAD'], runtime.git.integrationPath()), runtime.state.phase('phase-1')?.foundation);
    } finally { runtime.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('high intensity requires two distinct current reviewers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentmesh-high-'));
  try {
    runSync('git', ['init'], root);
    runSync('git', ['config', 'user.email', 'test@example.com'], root);
    runSync('git', ['config', 'user.name', 'Test'], root);
    writeFileSync(join(root, '.gitignore'), '.agentmesh/state.sqlite*\n.agentmesh/worktrees/\n.agentmesh/integration/\n');
    const plan = defaultPlan('library', [
      { id: 'codex', harness: 'codex', role: 'code' },
      { id: 'cursor', harness: 'cursor', role: 'review' },
      { id: 'gemini', harness: 'gemini', role: 'tests' }
    ]);
    plan.intensity = 'high';
    plan.phases[0]!.validation = [['node', '--version']];
    writePlan(root, plan);
    runSync('git', ['add', '.'], root); runSync('git', ['commit', '-m', 'base'], root);
    const runtime = new Runtime(root);
    try {
      runtime.begin();
      for (const agent of runtime.state.agents()) {
        writeFileSync(join(agent.worktree, `${agent.id}.txt`), agent.id);
        runSync('git', ['add', '.'], agent.worktree); runSync('git', ['commit', '-m', agent.id], agent.worktree);
        runtime.submitCheckpoint(agent.id, `${agent.id}-work`, { summary: 'done' });
      }
      for (const subject of plan.agents) {
        const reviewer = plan.agents.find(a => a.id !== subject.id)!;
        runtime.submitReview(reviewer.id, subject.id, 'approve', 'approved');
      }
      await assert.rejects(runtime.integrate(), /needs 2 current approval/);
      for (const subject of plan.agents) {
        const reviewer = plan.agents.filter(a => a.id !== subject.id)[1]!;
        runtime.submitReview(reviewer.id, subject.id, 'approve', 'approved');
      }
      await runtime.integrate();
      assert.equal(runtime.state.phase('phase-1')?.status, 'complete');
    } finally { runtime.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
