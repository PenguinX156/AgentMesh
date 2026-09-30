import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { adapters } from './harness.js';
import { runSync } from './process.js';
import { readPlan } from './config.js';

function mergeMcp(file: string, executable: string, root: string, agent: string) {
  let config: any = {};
  if (existsSync(file)) config = JSON.parse(readFileSync(file, 'utf8'));
  config.mcpServers ??= {};
  config.mcpServers.agentmesh = { command: process.execPath, args: [executable, 'mcp', '--root', resolve(root), '--agent', agent], cwd: resolve(root) };
  mkdirSync(resolve(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
}
export function installIntegrations(root: string, executable: string, configHome = homedir()) {
  const plan = readPlan(root);
  const results: { agent: string; harness: string; installed: boolean; mcpConfigured: boolean; detail: string }[] = [];
  const configured = new Set<string>();
  for (const agent of plan.agents) {
    const adapter = adapters[agent.harness];
    const installed = adapter.detect().installed;
    if (configured.has(agent.harness)) { results.push({ agent: agent.id, harness: agent.harness, installed, mcpConfigured: false, detail: 'One desktop harness cannot identify two agents through a single global MCP entry' }); continue; }
    if (!installed && agent.harness === 'codex') { results.push({ agent: agent.id, harness: agent.harness, installed, mcpConfigured: false, detail: 'Codex CLI is needed for automatic MCP registration' }); continue; }
    try {
      if (agent.harness === 'codex') {
        const name = 'agentmesh';
        try { runSync('codex', ['mcp', 'remove', name], root); } catch { /* not configured */ }
        runSync('codex', ['mcp', 'add', name, '--', process.execPath, executable, 'mcp', '--root', resolve(root), '--agent', agent.id], root);
        runSync('codex', ['mcp', 'get', name], root);
      } else if (agent.harness === 'cursor') mergeMcp(join(configHome, '.cursor', 'mcp.json'), executable, root, agent.id);
      else if (agent.harness === 'antigravity') mergeMcp(join(configHome, '.gemini', 'config', 'mcp_config.json'), executable, root, agent.id);
      else mergeMcp(join(configHome, '.gemini', 'settings.json'), executable, root, agent.id);
      configured.add(agent.harness);
      results.push({ agent: agent.id, harness: agent.harness, installed, mcpConfigured: true, detail: installed ? 'MCP configured; verify from harness' : 'MCP configured for manual app use; headless CLI unavailable' });
    } catch (error) { results.push({ agent: agent.id, harness: agent.harness, installed, mcpConfigured: false, detail: String(error) }); }
  }
  return results;
}
