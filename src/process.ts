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
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true, signal: options.signal, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const limit = options.maxOutput ?? 8 * 1024 * 1024;
    let timer: NodeJS.Timeout | undefined;
    if (options.timeoutMs) timer = setTimeout(() => child.kill(), options.timeoutMs);
    const collect = (current: string, chunk: Buffer) => {
      if (current.length + chunk.length > limit) { child.kill(); return current; }
      return current + chunk.toString();
    };
    child.stdout?.on('data', (c: Buffer) => { stdout = collect(stdout, c); });
    child.stderr?.on('data', (c: Buffer) => { stderr = collect(stderr, c); });
    child.on('error', error => { if (timer) clearTimeout(timer); reject(error); });
    child.on('close', code => {
      if (timer) clearTimeout(timer);
      if (code !== 0) reject(new ProcessError(command, args, code, stderr, stdout));
      else resolve({ stdout, stderr });
    });
  });
}
