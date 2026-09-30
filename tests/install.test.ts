import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultPlan, writePlan } from '../src/config.js';
import { installIntegrations } from '../src/install.js';

test('manual Cursor, Gemini, and Antigravity MCP setup uses explicit project identities', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'agentmesh-integrations-'));
  try {
    const plan = defaultPlan('library', [{ id: 'cursor', harness: 'cursor', role: 'developer' }, { id: 'gemini', harness: 'gemini', role: 'reviewer' }, { id: 'antigravity', harness: 'antigravity', role: 'developer' }]);
    writePlan(fixture, plan);
    const first = installIntegrations(fixture, 'C:\\tools\\agentmesh.js', fixture);
    assert.ok(first.every(item => item.mcpConfigured));
    const cursor = JSON.parse(readFileSync(join(fixture, '.cursor', 'mcp.json'), 'utf8'));
    const gemini = JSON.parse(readFileSync(join(fixture, '.gemini', 'settings.json'), 'utf8'));
    const antigravity = JSON.parse(readFileSync(join(fixture, '.gemini', 'config', 'mcp_config.json'), 'utf8'));
    for (const [config, agent] of [[cursor, 'cursor'], [gemini, 'gemini'], [antigravity, 'antigravity']] as const) {
      assert.deepEqual(config.mcpServers.agentmesh.args, ['C:\\tools\\agentmesh.js', 'mcp', '--root', fixture, '--agent', agent]);
    }
    installIntegrations(fixture, 'C:\\tools\\agentmesh.js', fixture);
    assert.equal(Object.keys(JSON.parse(readFileSync(join(fixture, '.cursor', 'mcp.json'), 'utf8')).mcpServers).length, 1);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
