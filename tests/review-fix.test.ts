import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultPlan, writePlan } from '../src/config.js';
import { Runtime } from '../src/runtime.js';
import { adapters, type HarnessAdapter } from '../src/harness.js';
import { runSync } from '../src/process.js';

test('requested changes resume the owner and require a new review', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentmesh-fix-'));
  const oldCodex = adapters.codex, oldGemini = adapters.gemini;
  try {
    runSync('git', ['init'], root);
    runSync('git', ['config', 'user.email', 'test@example.com'], root);
    runSync('git', ['config', 'user.name', 'Test'], root);
    writeFileSync(join(root, '.gitignore'), '.agentmesh/state.sqlite*\n.agentmesh/worktrees/\n.agentmesh/integration/\n');
    const plan = defaultPlan('library', [{ id: 'codex', harness: 'codex', role: 'code' }, { id: 'gemini', harness: 'gemini', role: 'review' }]);
    plan.phases[0]!.validation = [['node', '--version']];
    writePlan(root, plan);
    runSync('git', ['add', '.'], root); runSync('git', ['commit', '-m', 'base'], root);
    let codexReviews = 0, resumedFix = false;
    const fake = (id: 'codex' | 'gemini'): HarnessAdapter => ({
      name: id,
      detect: () => ({ installed: true, supportsResume: true, supportsExternalPrompt: true, supportsMCP: true, supportsCancellation: true, supportsPersistentSession: true, supportsStructuredOutput: true }),
      invoke: async (prompt, cwd, sessionId, _signal, _identity, mode) => {
        if (mode === 'review') {
          if (prompt.includes('Review codex')) { codexReviews++; return { text: JSON.stringify({ verdict: codexReviews === 1 ? 'changes_requested' : 'approve', body: 'Fix or approve' }), raw: '' }; }
          return { text: '{"verdict":"approve","body":"Looks good"}', raw: '' };
        }
        if (prompt.includes('Address this checkpoint review')) { resumedFix = sessionId === 'codex-session'; writeFileSync(join(cwd, 'codex-fix.txt'), 'fixed'); }
        else writeFileSync(join(cwd, `${id}.txt`), id);
        runSync('git', ['add', '.'], cwd); runSync('git', ['commit', '-m', id], cwd);
        return { text: 'done', sessionId: `${id}-session`, raw: '' };
      }
    });
    adapters.codex = fake('codex'); adapters.gemini = fake('gemini');
    const runtime = new Runtime(root);
    try {
      const result = await runtime.runPhase();
      assert.ok(result.integration, JSON.stringify(result));
      assert.equal(codexReviews, 2);
      assert.equal(resumedFix, true);
      assert.equal(runSync('git', ['show', 'agentmesh/integration:codex-fix.txt'], root), 'fixed');
    } finally { runtime.close(); }
  } finally { adapters.codex = oldCodex; adapters.gemini = oldGemini; rmSync(root, { recursive: true, force: true }); }
});
