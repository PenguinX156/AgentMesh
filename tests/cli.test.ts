import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
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
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
    const init = spawnSync(process.execPath, [cli, 'init', '--root', root, '--agents', 'codex,gemini', '--type', 'library'], { encoding: 'utf8' });
    assert.equal(init.status, 0, init.stderr);
    assert.deepEqual(JSON.parse(init.stdout).validation, [['npm', 'run', 'test']]);
    assert.ok(existsSync(join(root, '.agentmesh', 'collaboration-plan.json')));
    assert.ok(existsSync(join(root, '.agentmesh', '.gitignore')));
    const doctor = spawnSync(process.execPath, [cli, 'doctor', '--root', root], { encoding: 'utf8' });
    assert.equal(doctor.status, 0, doctor.stderr);
    const checks = JSON.parse(doctor.stdout);
    assert.equal(checks.plan.ok, true);
    assert.equal(checks.node.ok, true);
    assert.deepEqual(checks.database, { ok: true, detail: 'ok' });
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
    const inactive = new Client({ name: 'agentmesh-inactive-test', version: '1.0.0' });
    const inactiveTransport = new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp'], cwd: root, env: { ...process.env, AGENTMESH_ROOT: '', AGENTMESH_AGENT_ID: '' } as Record<string, string> });
    try {
      await inactive.connect(inactiveTransport);
      const response = await inactive.callTool({ name: 'get_project_context', arguments: {} });
      assert.equal(JSON.parse((response as { content: { text: string }[] }).content[0]!.text).active, false);
    } finally { await inactive.close(); }
    for (const gitArgs of [['config', 'user.email', 'test@example.com'], ['config', 'user.name', 'Test'], ['add', '.'], ['commit', '-m', 'base']]) {
      const git = spawnSync('git', gitArgs, { cwd: root, encoding: 'utf8' });
      assert.equal(git.status, 0, git.stderr);
    }
    const manual = spawnSync(process.execPath, [cli, 'start', '--manual', '--root', root], { encoding: 'utf8' });
    assert.equal(manual.status, 0, manual.stderr);
    const prepared = JSON.parse(manual.stdout);
    assert.equal(prepared.mode, 'manual');
    assert.equal(prepared.agents.length, 2);
    assert.ok(prepared.agents.every((agent: { worktree: string }) => existsSync(agent.worktree)));
    const codex = new Client({ name: 'agentmesh-codex-manual', version: '1.0.0' });
    const gemini = new Client({ name: 'agentmesh-gemini-manual', version: '1.0.0' });
    try {
      await codex.connect(new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp'], cwd: prepared.agents[0].worktree, env: { ...process.env, AGENTMESH_ROOT: '', AGENTMESH_AGENT_ID: '' } as Record<string, string> }));
      await gemini.connect(new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp'], cwd: prepared.agents[1].worktree, env: { ...process.env, AGENTMESH_ROOT: '', AGENTMESH_AGENT_ID: '' } as Record<string, string> }));
      const sent = await codex.callTool({ name: 'send_message', arguments: { recipient: 'gemini', kind: 'blocker', body: 'Need the shared interface clarified' } });
      assert.equal(sent.isError, undefined);
      const inbox = await gemini.callTool({ name: 'get_messages', arguments: {} });
      assert.match(JSON.stringify(inbox.content), /shared interface clarified/);
      const routine = await codex.callTool({ name: 'send_message', arguments: { recipient: 'gemini', kind: 'question', body: 'Routine progress?' } });
      assert.equal(routine.isError, true);
      writeFileSync(join(prepared.agents[0].worktree, 'manual.txt'), 'agent work');
      const checkpoint = await codex.callTool({ name: 'submit_checkpoint', arguments: { taskId: 'codex-work', summary: 'Done in the app worktree' } });
      assert.equal(checkpoint.isError, undefined, JSON.stringify(checkpoint.content));
      const committed = spawnSync('git', ['show', 'HEAD:manual.txt'], { cwd: prepared.agents[0].worktree, encoding: 'utf8' });
      assert.equal(committed.status, 0, committed.stderr);
      assert.equal(committed.stdout.trim(), 'agent work');
    } finally { await codex.close(); await gemini.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
