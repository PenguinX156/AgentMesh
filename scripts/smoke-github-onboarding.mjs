import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runSync } from '../dist/src/process.js';

const fixture = mkdtempSync(join(tmpdir(), 'agentmesh-github-'));
try {
  const root = join(fixture, 'project');
  const cli = resolve('dist/src/cli.js');
  const result = JSON.parse(runSync(process.execPath, [cli, 'init', '--repo', 'https://github.com/octocat/Hello-World.git', '--root', root, '--agents', 'codex,cursor,gemini'], fixture));
  if (result.root !== root || result.agents.length !== 3 || !existsSync(result.plan)) throw new Error('GitHub onboarding did not initialize AgentMesh');
  if (runSync('git', ['remote', 'get-url', 'origin'], root) !== 'https://github.com/octocat/Hello-World.git') throw new Error('Cloned repository has the wrong origin');
  console.log(JSON.stringify({ ok: true, agents: result.agents.map(agent => agent.harness) }));
} finally { rmSync(fixture, { recursive: true, force: true }); }
