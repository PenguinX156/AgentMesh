import spawn from 'cross-spawn';

export class ProcessError extends Error {
  constructor(readonly command: string, readonly args: string[], readonly code: number | null, readonly stderr: string, readonly stdout = '') {
    super(`${command} failed (${code ?? 'signal'}): ${(stdout + '\n' + stderr).trim().slice(-8000)}`);
  }
}

export function runSync(command: string, args: string[], cwd: string): string {
  const result = spawn.sync(command, args, { cwd, encoding: 'utf8', shell: false, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new ProcessError(command, args, result.status, result.stderr ?? '', result.stdout ?? '');
  return (result.stdout ?? '').trim();
}

export async function run(command: string, args: string[], cwd: string, options: { timeoutMs?: number; signal?: AbortSignal; maxOutput?: number; env?: NodeJS.ProcessEnv } = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) { reject(new Error(`${command} cancelled before launch`)); return; }
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32', env: options.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdoutChunks: Buffer[] = [], stderrChunks: Buffer[] = [];
    let stdoutBytes = 0, stderrBytes = 0;
    const limit = options.maxOutput ?? 8 * 1024 * 1024;
    let timer: NodeJS.Timeout | undefined;
    let reason: string | undefined;
    const killTree = (why: string) => {
      if (reason) return;
      reason = why;
      if (!child.pid) return;
      if (process.platform === 'win32') spawn.sync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else { try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill(); } }
    };
    const onAbort = () => killTree('cancelled');
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.timeoutMs) timer = setTimeout(() => killTree(`timed out after ${options.timeoutMs} ms`), options.timeoutMs);
    const collect = (chunks: Buffer[], current: number, chunk: Buffer) => {
      if (current + chunk.length > limit) { killTree(`exceeded ${limit} output bytes`); return current; }
      chunks.push(chunk); return current + chunk.length;
    };
    child.stdout?.on('data', (c: Buffer) => { stdoutBytes = collect(stdoutChunks, stdoutBytes, c); });
    child.stderr?.on('data', (c: Buffer) => { stderrBytes = collect(stderrChunks, stderrBytes, c); });
    const cleanup = () => { if (timer) clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort); };
    child.on('error', error => { cleanup(); reject(error); });
    child.on('close', code => {
      cleanup();
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (reason) reject(new Error(`${command} ${reason}: ${(stdout + '\n' + stderr).trim().slice(-4000)}`));
      else if (code !== 0) reject(new ProcessError(command, args, code, stderr, stdout));
      else resolve({ stdout, stderr });
    });
  });
}
