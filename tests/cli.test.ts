import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const cli = resolve(fileURLToPath(import.meta.url), '..', '..', 'src', 'cli.js');
test('CLI initializes a clean project, doctor reads state, and MCP answers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentmesh-cli-'));
  try {
    const init = spawnSync(process.execPath, [cli, 'init', '--root', root, '--agents', 'codex,gemini', '--type', 'library'], { encoding: 'utf8' });
    assert.equal(init.status, 0, init.stderr);
    assert.ok(existsSync(join(root, '.agentmesh', 'collaboration-plan.json')));
    assert.ok(existsSync(join(root, '.agentmesh', '.gitignore')));
    const doctor = spawnSync(process.execPath, [cli, 'doctor', '--root', root], { encoding: 'utf8' });
    assert.equal(doctor.status, 0, doctor.stderr);
    const checks = JSON.parse(doctor.stdout);
    assert.equal(checks.plan.ok, true);
    assert.equal(checks.node.ok, true);
    assert.equal(checks.database.integrity_check, 'ok');
    const client = new Client({ name: 'agentmesh-test', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp'], env: { ...process.env, AGENTMESH_ROOT: root, AGENTMESH_AGENT_ID: 'codex' } as Record<string, string> });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      assert.ok(tools.tools.some(tool => tool.name === 'submit_checkpoint'));
      const response = await client.callTool({ name: 'get_collaboration_plan', arguments: {} });
      assert.equal(response.isError, undefined);
      assert.match(JSON.stringify(response.content), /library/);
    } finally { await client.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
