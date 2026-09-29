import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { adapters } from './harness.js';
import { readPlan, planPath } from './config.js';
import { State } from './state.js';
import { Git } from './git.js';
import { runSync } from './process.js';

function probe(command: string, args: string[], root: string) { try { return { ok: true, detail: runSync(command, args, root).slice(0, 2000) }; } catch (error) { return { ok: false, detail: String(error) }; } }
export function doctor(root: string) {
  const checks: Record<string, unknown> = {};
  checks.node = { ok: Number(process.versions.node.split('.')[0]) >= 24, detail: process.version };
  checks.git = probe('git', ['--version'], root);
  checks.writable = (() => { try { accessSync(root, constants.W_OK); return { ok: true }; } catch (error) { return { ok: false, detail: String(error) }; } })();
  checks.plan = { ok: existsSync(planPath(root)), path: planPath(root) };
  checks.harnesses = Object.fromEntries(Object.entries(adapters).map(([name, adapter]) => {
    const capabilities = adapter.detect();
    const authentication = !capabilities.installed ? { ok: false, detail: 'CLI unavailable' }
      : name === 'codex' ? probe('codex', ['login', 'status'], root)
      : name === 'cursor' ? probe('cursor-agent', ['status'], root)
      : { ok: null, detail: 'Gemini CLI has no verified noninteractive auth probe' };
    return [name, { ...capabilities, authentication }];
  }));
  if (existsSync(planPath(root))) {
    try { checks.configuredAgents = readPlan(root).agents; }
    catch (error) { checks.plan = { ok: false, detail: String(error) }; }
    try { const state = new State(root); try { checks.database = state.db.prepare('PRAGMA integrity_check').get(); } finally { state.close(); } }
    catch (error) { checks.database = { ok: false, detail: String(error) }; }
    try { checks.worktrees = { ok: true, detail: new Git(root).call('worktree', 'list', '--porcelain').slice(0, 3000) }; }
    catch (error) { checks.worktrees = { ok: false, detail: String(error) }; }
  }
  const codexConfig = probe('codex', ['mcp', 'list'], root);
  checks.codexMcp = { ok: codexConfig.ok && codexConfig.detail.includes('agentmesh'), detail: codexConfig.detail };
  for (const [name, file] of [['cursorMcp', join(homedir(), '.cursor', 'mcp.json')], ['geminiMcp', join(homedir(), '.gemini', 'settings.json')]] as const) {
    try { const value = JSON.parse(readFileSync(file, 'utf8')); checks[name] = { ok: Boolean(value.mcpServers?.agentmesh), path: file }; }
    catch { checks[name] = { ok: false, path: file }; }
  }
  return checks;
}
