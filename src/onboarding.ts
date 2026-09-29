import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { run } from './process.js';

export function githubRepoName(remote: string): string {
  let owner: string, name: string;
  if (remote.startsWith('git@github.com:')) {
    const match = /^git@github\.com:([^/]+)\/([^/]+)$/.exec(remote);
    if (!match) throw new Error('Expected a GitHub owner/repository SSH URL');
    owner = match[1]!; name = match[2]!;
  } else {
    let url: URL;
    try { url = new URL(remote); } catch { throw new Error('Expected a GitHub repository URL'); }
    const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/');
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.search || url.hash || parts.length !== 2) throw new Error('Expected an HTTPS github.com/owner/repository URL');
    [owner, name] = parts as [string, string];
  }
  name = name.replace(/\.git$/, '');
  if (![owner, name].every(part => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part) && part !== '.' && part !== '..')) throw new Error('Unsafe GitHub owner or repository name');
  return name;
}

export async function cloneGithubRepo(remote: string, target: string): Promise<void> {
  githubRepoName(remote);
  if (existsSync(target)) throw new Error(`Target already exists: ${target}. Use --root to initialize an existing checkout.`);
  if (!existsSync(dirname(target))) throw new Error(`Parent directory does not exist: ${dirname(target)}`);
  await run('git', ['clone', '--quiet', '--', remote, target], dirname(target), {
    timeoutMs: 5 * 60 * 1000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  });
}
