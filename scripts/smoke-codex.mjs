import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAdapter } from '../dist/src/harness.js';
import { runSync } from '../dist/src/process.js';

const root = mkdtempSync(join(tmpdir(), 'agentmesh-real-codex-'));
try {
  runSync('git', ['init'], root);
  runSync('git', ['config', 'user.email', 'smoke@example.com'], root);
  runSync('git', ['config', 'user.name', 'Smoke'], root);
  writeFileSync(join(root, 'README.md'), '# Small CLI fixture\n');
  runSync('git', ['add', '.'], root);
  runSync('git', ['commit', '-m', 'base'], root);
  const adapter = new CodexAdapter();
  const result = await adapter.invoke('Reply with exactly AGENTMESH_OK. Do not edit files.', root, process.env.AGENTMESH_SMOKE_MODEL ?? 'gpt-5.3-codex', undefined, undefined, undefined, 'review');
  if (!result.text.includes('AGENTMESH_OK')) throw new Error(`Unexpected Codex response: ${result.text.slice(0, 500)}`);
  if (runSync('git', ['status', '--porcelain'], root)) throw new Error('Codex changed read-only fixture');
  console.log(JSON.stringify({ ok: true, sessionId: result.sessionId, text: result.text.slice(0, 200) }));
} finally {
  rmSync(root, { recursive: true, force: true });
}
