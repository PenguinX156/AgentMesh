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
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Harness returned an invalid JSON object');
  return value as Record<string, unknown>;
}
function nonempty(value: unknown, harness: HarnessName): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${harness} returned no final response`);
  return value;
}
function session(value: unknown, fallback?: string): string | undefined { return typeof value === 'string' && value ? value : fallback; }
export function parseCodexOutput(stdout: string, sessionId?: string): AgentResult {
  let id = sessionId, answer: string | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try { event = object(JSON.parse(line)); } catch { continue; }
    if (event.type === 'thread.started') id = session(event.thread_id, id);
    if (event.type === 'turn.failed') throw new Error(`codex turn failed: ${JSON.stringify(event.error ?? event)}`);
    if (event.type === 'item.completed') {
      const item = event.item && typeof event.item === 'object' ? event.item as Record<string, unknown> : undefined;
      if (item?.type === 'agent_message' && typeof item.text === 'string') answer = item.text;
    }
  }
  return { text: nonempty(answer, 'codex'), sessionId: id, raw: stdout };
}
export function parseCursorOutput(stdout: string, sessionId?: string): AgentResult {
  const result = object(JSON.parse(stdout));
  if (result.error) throw new Error(`cursor failed: ${JSON.stringify(result.error)}`);
  return { text: nonempty(result.result, 'cursor'), sessionId: session(result.session_id, sessionId), raw: stdout };
}
export function parseGeminiOutput(stdout: string, sessionId?: string): AgentResult {
  const result = object(JSON.parse(stdout));
  if (result.error) throw new Error(`gemini failed: ${JSON.stringify(result.error)}`);
  return { text: nonempty(result.response, 'gemini'), sessionId: session(result.session_id, sessionId), raw: stdout };
}
export class CodexAdapter implements HarnessAdapter {
  name = 'codex' as const;
  detect() { return capabilities(found('codex')); }
  async invoke(prompt: string, cwd: string, model?: string, sessionId?: string, signal?: AbortSignal, identity?: { root: string; agentId: string }, mode: 'work' | 'review' = 'work'): Promise<AgentResult> {
    const sandbox = mode === 'review' ? 'read-only' : 'workspace-write';
    const policy = ['-c', `sandbox_mode=${sandbox}`, '-c', 'approval_policy=never'];
    const args = sessionId
      ? ['exec', 'resume', '--json', ...policy, ...(model ? ['-m', model] : []), sessionId, prompt]
      : ['exec', '--json', '-C', cwd, '-s', sandbox, ...policy, ...(model ? ['-m', model] : []), prompt];
    const { stdout } = await run('codex', args, cwd, { signal, timeoutMs: 60 * 60 * 1000, env: agentEnv(identity) });
    return parseCodexOutput(stdout, sessionId);
  }
}
export class CursorAdapter implements HarnessAdapter {
  name = 'cursor' as const;
  detect() { return capabilities(found('cursor-agent')); }
  async invoke(prompt: string, cwd: string, model?: string, sessionId?: string, signal?: AbortSignal, identity?: { root: string; agentId: string }, mode: 'work' | 'review' = 'work'): Promise<AgentResult> {
    const { stdout } = await run('cursor-agent', ['-p', ...(mode === 'work' ? ['--force'] : []), '--output-format', 'json', ...(sessionId ? ['--resume', sessionId] : []), ...(model ? ['--model', model] : []), prompt], cwd, { signal, timeoutMs: 60 * 60 * 1000, env: agentEnv(identity) });
    return parseCursorOutput(stdout, sessionId);
  }
}
export class GeminiAdapter implements HarnessAdapter {
  name = 'gemini' as const;
  detect() { return capabilities(found('gemini')); }
  async invoke(prompt: string, cwd: string, model?: string, sessionId?: string, signal?: AbortSignal, identity?: { root: string; agentId: string }, mode: 'work' | 'review' = 'work'): Promise<AgentResult> {
    const { stdout } = await run('gemini', ['-p', prompt, '--output-format', 'json', '--approval-mode', mode === 'review' ? 'plan' : 'yolo', ...(sessionId ? ['--resume', sessionId] : []), ...(model ? ['--model', model] : [])], cwd, { signal, timeoutMs: 60 * 60 * 1000, env: agentEnv(identity) });
    return parseGeminiOutput(stdout, sessionId);
  }
}
export const adapters: Record<HarnessName, HarnessAdapter> = { codex: new CodexAdapter(), cursor: new CursorAdapter(), gemini: new GeminiAdapter() };
