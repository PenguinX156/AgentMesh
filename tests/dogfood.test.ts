import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultPlan, writePlan } from '../src/config.js';
import { Runtime } from '../src/runtime.js';
import { adapters, type HarnessAdapter } from '../src/harness.js';
import { runSync } from '../src/process.js';

test('dogfood: dependent tasks, automatic review, and validation run end to end', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentmesh-dogfood-'));
  const codex = adapters.codex, gemini = adapters.gemini;
  const calls: string[] = [];
  try {
    runSync('git', ['init'], root);
    runSync('git', ['config', 'user.email', 'test@example.com'], root);
    runSync('git', ['config', 'user.name', 'Test'], root);
    writeFileSync(join(root, '.gitignore'), '.agentmesh/state.sqlite*\n.agentmesh/worktrees/\n.agentmesh/integration/\n');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', type: 'module', scripts: { test: 'node --test' } }));
    const plan = defaultPlan('library', [{ id: 'codex', harness: 'codex', role: 'API' }, { id: 'gemini', harness: 'gemini', role: 'tests' }]);
    plan.phases[0]!.tasks[1]!.dependsOn = ['codex-work'];
    plan.phases[0]!.validation = [['npm', 'test']];
    writePlan(root, plan);
    runSync('git', ['add', '.'], root); runSync('git', ['commit', '-m', 'base'], root);
    const mock = (id: string): HarnessAdapter => ({
      name: id as 'codex' | 'gemini',
      detect: () => ({ installed: true, supportsResume: true, supportsExternalPrompt: true, supportsMCP: true, supportsCancellation: true, supportsPersistentSession: true, supportsStructuredOutput: true }),
      invoke: async (_prompt, cwd, _model, _session, _signal, _identity, mode) => {
        if (mode === 'review') return { text: JSON.stringify({ verdict: 'approve', body: 'Reviewed diff and tests' }), raw: '' };
        calls.push(id);
        if (id === 'codex') writeFileSync(join(cwd, 'index.mjs'), 'export const value = 42;\n');
        else writeFileSync(join(cwd, 'index.test.mjs'), "import { test } from 'node:test';\nimport { strict as assert } from 'node:assert';\nimport { value } from './index.mjs';\ntest('value', () => assert.equal(value, 42));\n");
        runSync('git', ['add', '.'], cwd); runSync('git', ['commit', '-m', `work by ${id}`], cwd);
        return { text: `${id} complete`, sessionId: `${id}-session`, raw: '' };
      }
    });
    adapters.codex = mock('codex'); adapters.gemini = mock('gemini');
    const runtime = new Runtime(root);
    try {
      const cycle = await runtime.runPhase();
      assert.ok(cycle.agentResults.every(r => r.status === 'fulfilled'));
      assert.deepEqual(calls, ['codex', 'gemini']);
      assert.ok(cycle.integration);
      assert.match(cycle.integration.output.join('\n'), /pass 1/);
      assert.equal(runtime.state.phase('phase-1')?.status, 'complete');
    } finally { runtime.close(); }
  } finally { adapters.codex = codex; adapters.gemini = gemini; rmSync(root, { recursive: true, force: true }); }
});
