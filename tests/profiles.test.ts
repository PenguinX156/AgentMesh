import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultPlan, writePlan } from '../src/config.js';
import { Runtime } from '../src/runtime.js';
import { adapters, type HarnessAdapter } from '../src/harness.js';
import { runSync } from '../src/process.js';

const scenarios = [
  {
    type: 'web-app',
    source: "import { createServer } from 'node:http';\nexport const createApp = () => createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end('<h1>AgentMesh web fixture</h1>'); });\n",
    check: "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { createApp } from './feature.mjs';\ntest('web response', async () => { const server = createApp(); await new Promise(resolve => server.listen(0, resolve)); try { const response = await fetch(`http://127.0.0.1:${server.address().port}`); assert.equal(response.status, 200); assert.match(await response.text(), /AgentMesh web fixture/); } finally { server.close(); } });\n"
  },
  {
    type: 'plugin',
    source: "export const manifest = { name: 'fixture', tools: [{ name: 'echo', inputSchema: { type: 'object' } }] };\nexport const callTool = ({ text }) => ({ content: [{ type: 'text', text }] });\n",
    check: "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { manifest, callTool } from './feature.mjs';\ntest('plugin manifest and call', () => { assert.equal(manifest.tools[0].name, 'echo'); assert.deepEqual(callTool({ text: 'ok' }), { content: [{ type: 'text', text: 'ok' }] }); });\n"
  },
  {
    type: 'game',
    source: "export const step = (state, input) => ({ x: state.x + input.dx, score: state.score + (input.collect ? 1 : 0) });\n",
    check: "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { step } from './feature.mjs';\ntest('deterministic game step', () => assert.deepEqual(step({ x: 2, score: 0 }, { dx: 3, collect: true }), { x: 5, score: 1 }));\n"
  }
] as const;

for (const scenario of scenarios) test(`${scenario.type} fixture integrates and validates`, async () => {
  const root = mkdtempSync(join(tmpdir(), `agentmesh-${scenario.type}-`));
  const originalCodex = adapters.codex, originalGemini = adapters.gemini;
  try {
    runSync('git', ['init'], root);
    runSync('git', ['config', 'user.email', 'test@example.com'], root);
    runSync('git', ['config', 'user.name', 'Test'], root);
    writeFileSync(join(root, '.gitignore'), '.agentmesh/state.sqlite*\n.agentmesh/worktrees/\n.agentmesh/integration/\n');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', type: 'module' }));
    const plan = defaultPlan(scenario.type, [{ id: 'codex', harness: 'codex', role: 'implementation' }, { id: 'gemini', harness: 'gemini', role: 'verification' }]);
    plan.phases[0]!.tasks[1]!.dependsOn = ['codex-work'];
    plan.phases[0]!.validation = [['node', '--test']];
    writePlan(root, plan);
    runSync('git', ['add', '.'], root); runSync('git', ['commit', '-m', 'base'], root);
    const fake = (id: 'codex' | 'gemini'): HarnessAdapter => ({
      name: id,
      detect: () => ({ installed: true, supportsResume: true, supportsExternalPrompt: true, supportsMCP: true, supportsCancellation: true, supportsPersistentSession: true, supportsStructuredOutput: true }),
      invoke: async (_prompt, cwd, _session, _signal, _identity, mode) => {
        if (mode === 'review') return { text: '{"verdict":"approve","body":"Reviewed fixture"}', raw: '' };
        writeFileSync(join(cwd, id === 'codex' ? 'feature.mjs' : 'feature.test.mjs'), id === 'codex' ? scenario.source : scenario.check);
        runSync('git', ['add', '.'], cwd); runSync('git', ['commit', '-m', id], cwd);
        return { text: 'done', raw: '' };
      }
    });
    adapters.codex = fake('codex'); adapters.gemini = fake('gemini');
    const runtime = new Runtime(root);
    try {
      const result = await runtime.runPhase();
      assert.ok(result.integration, JSON.stringify(result));
      assert.match(result.integration.output.join('\n'), /pass 1/);
      assert.equal(runtime.state.phase('phase-1')?.status, 'complete');
    } finally { runtime.close(); }
  } finally { adapters.codex = originalCodex; adapters.gemini = originalGemini; rmSync(root, { recursive: true, force: true }); }
});
