import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { githubRepoName } from '../src/onboarding.js';
import { validatePlan, defaultPlan } from '../src/config.js';

const cli = resolve(fileURLToPath(import.meta.url), '..', '..', 'src', 'cli.js');

test('GitHub onboarding accepts canonical HTTPS and SSH remotes and rejects unsafe forms', () => {
  assert.equal(githubRepoName('https://github.com/example/project.git'), 'project');
  assert.equal(githubRepoName('git@github.com:example/project.git'), 'project');
  for (const remote of ['https://evil.example/example/project', 'https://github.com/example/project?x=1', 'https://github.com/example/../project', 'git@github.com:example/../project']) {
    assert.throws(() => githubRepoName(remote));
  }
});

test('agent plans reject model overrides so the harness owns model selection', () => {
  const plan = defaultPlan('library', [{ id: 'codex', harness: 'codex', role: 'developer' }]);
  assert.throws(() => validatePlan({ ...plan, agents: [{ ...plan.agents[0], model: 'hardcoded' }] }));
});

test('setup initializes a local project and connects selected MCP harnesses in one command', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'agentmesh-setup-'));
  const root = join(fixture, 'project');
  const userHome = join(fixture, 'home');
  try {
    mkdirSync(root); mkdirSync(userHome);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
    const result = spawnSync(process.execPath, [cli, 'setup', '--root', root, '--agents', 'cursor,gemini'], {
      encoding: 'utf8', env: { ...process.env, HOME: userHome, USERPROFILE: userHome }
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.agents.length, 2);
    assert.deepEqual(output.validation, [['npm', 'run', 'test']]);
    assert.ok(output.integrations.every((entry: { mcpConfigured: boolean }) => entry.mcpConfigured));
    const plan = JSON.parse(readFileSync(join(root, '.agentmesh', 'collaboration-plan.json'), 'utf8'));
    assert.deepEqual(plan.agents.map((agent: { harness: string }) => agent.harness), ['cursor', 'gemini']);
    for (const file of [join(userHome, '.cursor', 'mcp.json'), join(userHome, '.gemini', 'settings.json')]) {
      assert.ok(JSON.parse(readFileSync(file, 'utf8')).mcpServers.agentmesh);
    }
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
