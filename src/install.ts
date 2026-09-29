import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { adapters } from './harness.js';
import { runSync } from './process.js';
import { readPlan } from './config.js';

function mergeMcp(file: string, executable: string) {
  let config: any = {};
  if (existsSync(file)) config = JSON.parse(readFileSync(file, 'utf8'));
  config.mcpServers ??= {};
  config.mcpServers.agentmesh = { command: process.execPath, args: [executable, 'mcp'] };
  mkdirSync(resolve(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
}
export function installIntegrations(root: string, executable: string) {
  const plan = readPlan(root);
  const results: { agent: string; harness: string; installed: boolean; mcpConfigured: boolean; detail: string }[] = [];
  const configured = new Set<string>();
  for (const agent of plan.agents) {
    const adapter = adapters[agent.harness];
    const installed = adapter.detect().installed;
    if (!installed) { results.push({ agent: agent.id, harness: agent.harness, installed, mcpConfigured: false, detail: 'CLI not found' }); continue; }
    if (configured.has(agent.harness)) { results.push({ agent: agent.id, harness: agent.harness, installed, mcpConfigured: true, detail: 'Shared harness configuration; agent identity is provided at launch' }); continue; }
    try {
      if (agent.harness === 'codex') {
        const name = 'agentmesh';
        try { runSync('codex', ['mcp', 'remove', name], root); } catch { /* not configured */ }
        runSync('codex', ['mcp', 'add', name, '--', process.execPath, executable, 'mcp'], root);
        runSync('codex', ['mcp', 'get', name], root);
      } else if (agent.harness === 'cursor') mergeMcp(join(homedir(), '.cursor', 'mcp.json'), executable);
      else mergeMcp(join(homedir(), '.gemini', 'settings.json'), executable);
      configured.add(agent.harness);
      results.push({ agent: agent.id, harness: agent.harness, installed, mcpConfigured: true, detail: 'Configured; verify from harness' });
    } catch (error) { results.push({ agent: agent.id, harness: agent.harness, installed, mcpConfigured: false, detail: String(error) }); }
  }
  return results;
}
