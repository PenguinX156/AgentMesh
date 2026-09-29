import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { defaultPlan, writePlan } from '../dist/src/config.js';
import { runSync } from '../dist/src/process.js';

const fixture = mkdtempSync(join(tmpdir(), 'agentmesh-install-'));
const project = join(fixture, 'project');
const codexHome = join(fixture, 'codex-home');
const previous = process.env.CODEX_HOME;
try {
  mkdirSync(project); mkdirSync(codexHome);
  process.env.CODEX_HOME = codexHome;
  writePlan(project, defaultPlan('cli', [{ id: 'codex', harness: 'codex', role: 'developer' }]));
  const cli = resolve('dist/src/cli.js');
  const result = JSON.parse(runSync(process.execPath, [cli, 'install-integrations', '--root', project], project));
  if (!result[0]?.mcpConfigured) throw new Error(`Installation failed: ${JSON.stringify(result)}`);
  const config = runSync('codex', ['mcp', 'get', 'agentmesh'], project);
  if (!config.includes('agentmesh')) throw new Error('Codex did not persist MCP configuration');
  console.log(JSON.stringify({ ok: true, configured: result[0].harness }));
} finally {
  if (previous === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previous;
  rmSync(fixture, { recursive: true, force: true });
}
