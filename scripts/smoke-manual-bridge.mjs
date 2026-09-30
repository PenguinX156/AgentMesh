import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Pass the initialized project root');
const cli = resolve(fileURLToPath(import.meta.url), '..', '..', 'dist', 'src', 'cli.js');
const phase = JSON.parse(readFileSync(join(root, '.agentmesh', 'collaboration-plan.json'), 'utf8')).currentPhase;
for (const agent of ['codex', 'cursor', 'antigravity']) {
  const client = new Client({ name: 'agentmesh-manual-smoke', version: '1.0.0' });
  const worktree = join(root, '.agentmesh', 'worktrees', phase, agent);
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp', '--root', root, '--agent', 'codex'], cwd: worktree });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    if (!tools.tools.some(tool => tool.name === 'submit_checkpoint') || !tools.tools.some(tool => tool.name === 'prepare_task')) throw new Error(`${agent}: missing collaboration tools`);
    const context = await client.callTool({ name: 'get_project_context', arguments: {} });
    const value = JSON.parse(context.content.find(item => item.type === 'text').text);
    if (value.agentId !== agent || value.phase?.id !== phase) throw new Error(`${agent}: wrong MCP identity ${JSON.stringify(value)}`);
    const tasks = await client.callTool({ name: 'get_my_task', arguments: {} });
    const assigned = JSON.parse(tasks.content.find(item => item.type === 'text').text);
    if (assigned.length !== 1 || assigned[0].owner !== agent || !['pending', 'working', 'complete'].includes(assigned[0].status)) throw new Error(`${agent}: wrong task ${JSON.stringify(assigned)}`);
    console.log(`${agent}: MCP connected, identity and task verified`);
  } finally { await client.close(); }
}
