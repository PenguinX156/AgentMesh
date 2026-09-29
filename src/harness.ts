import { run, runSync } from './process.js';

export type HarnessName = 'codex' | 'cursor' | 'gemini';
export interface Capabilities { installed: boolean; supportsResume: boolean; supportsExternalPrompt: boolean; supportsMCP: boolean; supportsCancellation: boolean; supportsPersistentSession: boolean; supportsStructuredOutput: boolean; }
export interface AgentResult { text: string; sessionId?: string; raw: string; }
export interface HarnessAdapter {
  name: HarnessName;
  detect(): Capabilities;
  invoke(prompt: string, cwd: string, model?: string, sessionId?: string, signal?: AbortSignal, identity?: { root: string; agentId: string }, mode?: 'work' | 'review'): Promise<AgentResult>;
}
function agentEnv(identity?: { root: string; agentId: string }) { return identity ? { ...process.env, AGENTMESH_ROOT: identity.root, AGENTMESH_AGENT_ID: identity.agentId } : process.env; }
function found(command: string) { try { runSync(command, ['--version'], process.cwd()); return true; } catch { return false; } }
function capabilities(installed: boolean): Capabilities { return { installed, supportsResume: true, supportsExternalPrompt: true, supportsMCP: true, supportsCancellation: true, supportsPersistentSession: true, supportsStructuredOutput: true }; }
export class CodexAdapter implements HarnessAdapter {
  name = 'codex' as const;
  detect() { return capabilities(found('codex')); }
  async invoke(prompt: string, cwd: string, model?: string, sessionId?: string, signal?: AbortSignal, identity?: { root: string; agentId: string }, mode: 'work' | 'review' = 'work'): Promise<AgentResult> {
    const args = sessionId
      ? ['exec', 'resume', '--json', ...(model ? ['-m', model] : []), sessionId, prompt]
      : ['exec', '--json', '-C', cwd, ...(mode === 'review' ? ['-s', 'read-only'] : []), ...(model ? ['-m', model] : []), prompt];
    const { stdout } = await run('codex', args, cwd, { signal, timeoutMs: 60 * 60 * 1000, env: agentEnv(identity) });
    let id = sessionId, text = '';
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { const event = JSON.parse(line); if (event.type === 'thread.started') id = event.thread_id; if (event.type === 'item.completed' && event.item?.type === 'agent_message') text = event.item.text; } catch { /* diagnostic lines */ }
    }
    return { text, sessionId: id, raw: stdout };
  }
}
export class CursorAdapter implements HarnessAdapter {
  name = 'cursor' as const;
  detect() { return capabilities(found('cursor-agent')); }
  async invoke(prompt: string, cwd: string, model?: string, sessionId?: string, signal?: AbortSignal, identity?: { root: string; agentId: string }, mode: 'work' | 'review' = 'work'): Promise<AgentResult> {
    const { stdout } = await run('cursor-agent', ['-p', ...(mode === 'work' ? ['--force'] : []), '--output-format', 'json', ...(sessionId ? ['--resume', sessionId] : []), ...(model ? ['--model', model] : []), prompt], cwd, { signal, timeoutMs: 60 * 60 * 1000, env: agentEnv(identity) });
    const result = JSON.parse(stdout);
    return { text: result.result ?? '', sessionId: result.session_id ?? sessionId, raw: stdout };
  }
}
export class GeminiAdapter implements HarnessAdapter {
  name = 'gemini' as const;
  detect() { return capabilities(found('gemini')); }
  async invoke(prompt: string, cwd: string, model?: string, sessionId?: string, signal?: AbortSignal, identity?: { root: string; agentId: string }, mode: 'work' | 'review' = 'work'): Promise<AgentResult> {
    const { stdout } = await run('gemini', ['-p', prompt, '--output-format', 'json', '--approval-mode', mode === 'review' ? 'plan' : 'yolo', ...(sessionId ? ['--resume', sessionId] : []), ...(model ? ['--model', model] : [])], cwd, { signal, timeoutMs: 60 * 60 * 1000, env: agentEnv(identity) });
    const result = JSON.parse(stdout);
    return { text: result.response ?? result.result ?? '', sessionId: result.session_id ?? sessionId, raw: stdout };
  }
}
export const adapters: Record<HarnessName, HarnessAdapter> = { codex: new CodexAdapter(), cursor: new CursorAdapter(), gemini: new GeminiAdapter() };
