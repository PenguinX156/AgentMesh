import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultPlan, readPlan, writePlan } from '../src/config.js';
import { Runtime } from '../src/runtime.js';
import { runSync } from '../src/process.js';

test('multi-task checkpoints, dependency transfer, reviews, and final advance', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentmesh-regression-'));
  try {
    runSync('git', ['init'], root);
    runSync('git', ['config', 'user.name', 'Test'], root);
    runSync('git', ['config', 'user.email', 'test@example.com'], root);
    writeFileSync(join(root, '.gitignore'), '.agentmesh/state.sqlite*\n.agentmesh/worktrees/\n.agentmesh/integration/\n');
    const plan = defaultPlan('game', [{ id: 'codex', harness: 'codex', role: 'logic' }, { id: 'cursor', harness: 'cursor', role: 'test' }]);
    plan.phases = [{ id: 'phase-1', title: 'Slice', contracts: [], validation: [['node', '--version']], tasks: [
      { id: 'logic-a', title: 'A', owner: 'codex', dependsOn: [], instructions: '' },
      { id: 'logic-b', title: 'B', owner: 'codex', dependsOn: ['logic-a'], instructions: '' },
      { id: 'logic-test', title: 'Test', owner: 'cursor', dependsOn: ['logic-b'], instructions: '' }
    ] }];
    writePlan(root, plan);
    runSync('git', ['add', '.'], root); runSync('git', ['commit', '-m', 'base'], root);
    const runtime = new Runtime(root);
    try {
      runtime.begin();
      const codex = runtime.state.agents().find(agent => agent.id === 'codex')!;
      const cursor = runtime.state.agents().find(agent => agent.id === 'cursor')!;
      assert.throws(() => runtime.submitCheckpoint('cursor', 'logic-test', { summary: 'too early' }), /Dependency logic-b/);
      writeFileSync(join(codex.worktree, 'logic-a.txt'), 'a');
      runtime.submitCheckpoint('codex', 'logic-a', { summary: 'A done' });
      writeFileSync(join(codex.worktree, 'logic-b.txt'), 'b');
      runtime.submitCheckpoint('codex', 'logic-b', { summary: 'B done' });
      assert.equal(runtime.sendMessage('codex', 'cursor', 'review', 'Please check A and B').queued, true);
      assert.equal(runtime.syncDependencies('cursor', 'logic-test').synced[0], 'logic-b');
      assert.equal(runSync('git', ['show', 'HEAD:logic-b.txt'], cursor.worktree), 'b');
      writeFileSync(join(cursor.worktree, 'test.txt'), 'tested');
      runtime.submitCheckpoint('cursor', 'logic-test', { summary: 'Test done' });
      runtime.submitReview('cursor', 'codex', 'approve', 'approved');
      runtime.submitReview('codex', 'cursor', 'approve', 'approved');
      runtime.submitCheckpoint('codex', 'logic-b', { summary: 'Repeated with same commit' });
      assert.equal((runtime.state.db.prepare('SELECT COUNT(*) AS count FROM reviews WHERE subject=?').get('codex') as { count: number }).count, 1);
      await runtime.integrate();
      const advanced = runtime.advance();
      assert.equal(advanced.complete, true);
      assert.equal(readPlan(root).completed, true);
      assert.equal(runSync('git', ['show', 'HEAD:test.txt'], root), 'tested');
    } finally { runtime.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
