import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultPlan, readPlan, writePlan } from '../src/config.js';
import { collaboratePlan } from '../src/planning.js';
import { adapters, type HarnessAdapter } from '../src/harness.js';
import { runSync } from '../src/process.js';

test('collaborative planning validates a harness-authored draft and cleans worktrees', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentmesh-plan-'));
  const originalAdapter = adapters.codex;
  try {
    runSync('git', ['init'], root);
    runSync('git', ['config', 'user.email', 'test@example.com'], root);
    runSync('git', ['config', 'user.name', 'Test'], root);
    writeFileSync(join(root, '.gitignore'), '.agentmesh/state.sqlite*\n.agentmesh/worktrees/\n.agentmesh/integration/\n');
    writeFileSync(join(root, 'README.md'), '# CLI fixture\n');
    const plan = defaultPlan('cli', [{ id: 'codex', harness: 'codex', role: 'implementation' }]);
    writePlan(root, plan);
    runSync('git', ['add', '.'], root); runSync('git', ['commit', '-m', 'base'], root);
    let calls = 0;
    adapters.codex = { name: 'codex', detect: () => ({ installed: true, supportsResume: true, supportsExternalPrompt: true, supportsMCP: true, supportsCancellation: true, supportsPersistentSession: true, supportsStructuredOutput: true }),
      invoke: async prompt => { calls++; if (prompt.includes('Synthesize')) return { text: JSON.stringify({ ...plan, phases: plan.phases.map(p => ({ ...p, validation: [['node', '--version']] })) }), raw: '' }; return { text: 'Build a CLI in phases.', raw: '' }; }
    } as HarnessAdapter;
    const result = await collaboratePlan(root);
    assert.equal(calls, 2);
    assert.equal(readPlan(root).phases[0]!.validation[0]![0], 'node');
    assert.ok(result.cleanup.every(c => !c.error));
  } finally { adapters.codex = originalAdapter; rmSync(root, { recursive: true, force: true }); }
});
