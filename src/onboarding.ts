import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { adapters, type HarnessName } from './harness.js';
import { defaultPlan, inferProjectType, planPath, writePlan } from './config.js';
import { State } from './state.js';
import { run, runSync } from './process.js';

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

export async function initializeProject(root: string, names: HarnessName[], remote?: string, projectType?: string) {
  root = resolve(root);
  if (!names.length) throw new Error('Choose at least one agent harness');
  for (const name of names) if (!adapters[name]) throw new Error(`Unknown harness: ${name}`);
  if (remote) await cloneGithubRepo(remote, root);
  if (existsSync(planPath(root))) throw new Error('Collaboration plan already exists');
  if (!existsSync(join(root, '.git'))) runSync('git', ['init'], root);
  const counts = new Map<string, number>();
  const agents = names.map(name => {
    const n = (counts.get(name) ?? 0) + 1;
    counts.set(name, n);
    return { id: n === 1 ? name : `${name}-${n}`, harness: name, role: 'developer' };
  });
  const plan = defaultPlan(projectType ?? inferProjectType(root), agents);
  const packageFile = join(root, 'package.json');
  if (existsSync(packageFile)) {
    const scripts = JSON.parse(readFileSync(packageFile, 'utf8')).scripts ?? {};
    const validation = ['test', 'build', 'lint', 'typecheck'].filter(name => typeof scripts[name] === 'string').map(name => ['npm', 'run', name]);
    for (const phase of plan.phases) phase.validation = validation;
  }
  writePlan(root, plan);
  writeFileSync(join(root, '.agentmesh', '.gitignore'), 'state.sqlite*\nworktrees/\nintegration/\n');
  const state = new State(root); state.close();
  return { root, plan: planPath(root), agents, validation: plan.phases[0]?.validation };
}
