import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { resolve, join, isAbsolute } from 'node:path';
import { runSync } from './process.js';

const safeRef = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/;
export class Git {
  readonly root: string;
  constructor(root: string) {
    this.root = realpathSync(root);
    const top = runSync('git', ['rev-parse', '--show-toplevel'], this.root);
    if (resolve(top).toLowerCase() !== this.root.toLowerCase()) throw new Error('Run AgentMesh from the repository root');
  }
  call(...args: string[]) { return runSync('git', args, this.root); }
  head() { return this.call('rev-parse', 'HEAD'); }
  requireClean() { if (this.call('status', '--porcelain')) throw new Error('Commit or stash changes before starting a phase'); }
  ensureRef(ref: string) { if (!safeRef.test(ref) || ref.includes('..') || ref.endsWith('.lock')) throw new Error(`Unsafe Git ref: ${ref}`); }
  branchExists(ref: string) { this.ensureRef(ref); try { this.call('show-ref', '--verify', '--quiet', `refs/heads/${ref}`); return true; } catch { return false; } }
  ensureBranch(ref: string, base: string) { this.ensureRef(ref); if (!this.branchExists(ref)) this.call('branch', ref, base); }
  worktreePath(phase: string, agent: string) { return join(this.root, '.agentmesh', 'worktrees', phase, agent); }
  createWorktree(phase: string, agent: string, base: string): { branch: string; path: string } {
    const branch = `agentmesh/${phase}/${agent}`;
    this.ensureRef(branch);
    const path = this.worktreePath(phase, agent);
    if (existsSync(path)) {
      const currentBranch = runSync('git', ['branch', '--show-current'], path);
      const currentHead = runSync('git', ['rev-parse', 'HEAD'], path);
      if (currentBranch !== branch || currentHead !== base || runSync('git', ['status', '--porcelain'], path)) throw new Error(`Existing worktree is not a clean phase foundation: ${path}`);
      return { branch, path };
    }
    mkdirSync(resolve(path, '..'), { recursive: true });
    if (this.branchExists(branch)) {
      if (this.call('rev-parse', branch) !== base) throw new Error(`Existing branch is not at the phase foundation: ${branch}`);
      this.call('worktree', 'add', path, branch);
    } else this.call('worktree', 'add', '-b', branch, path, base);
    return { branch, path };
  }
  removeWorktree(phase: string, agent: string) {
    const path = this.worktreePath(phase, agent);
    const registered = this.call('worktree', 'list', '--porcelain').split(/\r?\n/).some(line => line === `worktree ${path.replaceAll('\\', '/')}` || line === `worktree ${path}`);
    if (!registered) throw new Error(`Refusing to remove unregistered worktree: ${path}`);
    if (runSync('git', ['status', '--porcelain'], path)) throw new Error(`Worktree has uncommitted changes: ${path}`);
    this.call('worktree', 'remove', path);
  }
  verifyCommit(branch: string, foundation: string) {
    const head = this.call('rev-parse', branch);
    if (this.call('merge-base', head, foundation) !== foundation) throw new Error(`${branch} does not descend from the phase foundation`);
    return head;
  }
  changedFiles(foundation: string, branch: string) { return this.call('diff', '--name-only', `${foundation}..${branch}`).split(/\r?\n/).filter(Boolean); }
  diff(foundation: string, branch: string, maxBytes = 60000) { return this.call('diff', '--no-ext-diff', '--unified=3', `${foundation}..${branch}`).slice(0, maxBytes); }
  assertContracts(foundation: string, branch: string, contracts: string[]) {
    const changed = this.changedFiles(foundation, branch);
    for (const contract of contracts) {
      const normalized = contract.replaceAll('\\', '/').replace(/\/$/, '');
      if (!normalized || normalized === '.' || isAbsolute(contract) || /^[a-zA-Z]:/.test(contract) || normalized.split('/').includes('..') || normalized.startsWith('/')) throw new Error(`Unsafe contract path: ${contract}`);
      if (changed.some(file => file === normalized || file.startsWith(`${normalized}/`))) throw new Error(`Frozen contract changed on ${branch}: ${contract}`);
    }
  }
  integrate(branches: string[], foundation: string, integration: string): string {
    this.ensureRef(integration);
    this.ensureBranch(integration, foundation);
    const path = join(this.root, '.agentmesh', 'integration');
    if (!existsSync(path)) { mkdirSync(resolve(path, '..'), { recursive: true }); this.call('worktree', 'add', path, integration); }
    if (runSync('git', ['branch', '--show-current'], path) !== integration) throw new Error('Integration checkout is on the wrong branch');
    if (runSync('git', ['status', '--porcelain'], path)) throw new Error('Integration checkout has uncommitted changes');
    const current = runSync('git', ['rev-parse', 'HEAD'], path);
    if (current !== foundation) throw new Error(`Integration branch is at ${current}; expected ${foundation}`);
    for (const branch of branches) runSync('git', ['merge', '--no-ff', '--no-edit', branch], path);
    return runSync('git', ['rev-parse', 'HEAD'], path);
  }
  integrationPath() { return join(this.root, '.agentmesh', 'integration'); }
  resetFailedIntegration(phase: string, foundation: string, integration: string) {
    const path = this.integrationPath();
    if (!existsSync(path)) return null;
    const actualBranch = runSync('git', ['branch', '--show-current'], path);
    if (actualBranch !== integration) throw new Error(`Integration checkout is on ${actualBranch}, expected ${integration}`);
    try { runSync('git', ['merge', '--abort'], path); } catch { /* no merge in progress */ }
    if (runSync('git', ['status', '--porcelain'], path)) throw new Error('Integration checkout has changes; inspect them before recovery');
    const current = runSync('git', ['rev-parse', 'HEAD'], path);
    if (current !== foundation) {
      const backup = `agentmesh/failed/${phase}/${Date.now()}`;
      this.ensureRef(backup);
      runSync('git', ['branch', backup, current], path);
      runSync('git', ['reset', '--hard', foundation], path);
      return backup;
    }
    return null;
  }
}
