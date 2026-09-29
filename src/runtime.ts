import { readPlan, writePlan, validatePlan, type Plan } from './config.js';
import { Git } from './git.js';
import { State } from './state.js';
import { adapters } from './harness.js';
import { run, runSync } from './process.js';

export class Runtime {
  readonly plan: Plan;
  readonly git: Git;
  readonly state: State;
  constructor(readonly root: string) { this.plan = readPlan(root); this.git = new Git(root); this.state = new State(root); }
  close() { this.state.close(); }
  current() { const phase = this.plan.phases.find(p => p.id === this.plan.currentPhase); if (!phase) throw new Error('Unknown phase'); return phase; }
  begin() {
    const phase = this.current();
    const existing = this.state.phase(phase.id);
    if (existing) return existing;
    const created: { id: string; path: string }[] = [];
    try {
      this.state.transaction(() => {
        if (this.state.phase(phase.id)) return;
        this.git.requireClean();
        const foundation = this.git.head();
        for (const agent of this.plan.agents) {
          const worktree = this.git.createWorktree(phase.id, agent.id, foundation);
          created.push({ id: agent.id, path: worktree.path });
        }
        this.state.db.prepare('INSERT INTO phases(id,status,foundation) VALUES(?,?,?)').run(phase.id, 'working', foundation);
        for (const agent of this.plan.agents) {
          const worktree = created.find(w => w.id === agent.id)!;
          this.state.db.prepare('INSERT INTO agents(id,harness,branch,worktree) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET harness=excluded.harness, branch=excluded.branch, worktree=excluded.worktree, session_id=NULL')
            .run(agent.id, agent.harness, `agentmesh/${phase.id}/${agent.id}`, worktree.path);
        }
        for (const task of phase.tasks) this.state.db.prepare('INSERT INTO tasks(id,phase_id,owner,status) VALUES(?,?,?,?)').run(task.id, phase.id, task.owner, 'pending');
        this.state.event(phase.id, null, 'phase_started', { foundation, contracts: phase.contracts });
      });
    } catch (error) {
      for (const item of created.reverse()) { try { this.git.removeWorktree(phase.id, item.id); } catch { /* leave diagnostic state */ } }
      throw error;
    }
    return this.state.phase(phase.id)!;
  }
  getTask(agentId: string) { return this.current().tasks.filter(t => t.owner === agentId); }
  async runAgents(signal?: AbortSignal) {
    const phase = this.current();
    const state = this.begin();
    if (state.status !== 'working') throw new Error(`Phase is ${state.status}`);
    const allResults: PromiseSettledResult<{ agent: string; task: string; result: string }>[] = [];
    while (true) {
      const statuses = new Map(this.state.tasks(phase.id).map(t => [t.id, t.status]));
      if ([...statuses.values()].every(s => s === 'complete')) break;
      const ready = phase.tasks.filter(t => statuses.get(t.id) !== 'complete' && statuses.get(t.id) !== 'blocked' && t.dependsOn.every(dep => statuses.get(dep) === 'complete'));
      const batch = [...new Map(ready.map(t => [t.owner, t])).values()];
      if (!batch.length) throw new Error('No runnable tasks; inspect blocked tasks and dependencies');
      const results = await Promise.allSettled(batch.map(async task => {
        const agent = this.plan.agents.find(a => a.id === task.owner)!;
        const row = this.state.agents().find(a => a.id === agent.id)!;
        const adapter = adapters[agent.harness];
        if (!adapter.detect().installed) throw new Error(`${agent.harness} CLI is unavailable`);
        const failure = this.state.db.prepare("SELECT output FROM integrations WHERE phase_id=? AND status='failed' ORDER BY id DESC LIMIT 1").get(phase.id) as { output: string } | undefined;
        const prompt = [
          `You are ${agent.id} in AgentMesh phase ${phase.id}: ${phase.title}.`,
          `Work only in this checkout. Foundation: ${state.foundation}.`,
          `Task: ${JSON.stringify(task)}.`,
          `Frozen contracts: ${JSON.stringify([...phase.contracts, '.agentmesh/collaboration-plan.json'])}. Do not change these.`,
          failure ? `Last integration failure: ${failure.output.slice(0, 5000)}` : '',
          'Work independently. Commit all important work before completing.',
          'Only communicate early for blockers, contract conflicts, or critical discoveries.',
          'At completion, give a compact report of changes, tests, decisions, and risks.'
        ].filter(Boolean).join('\n');
        this.state.db.prepare("UPDATE tasks SET status='working' WHERE phase_id=? AND id=?").run(phase.id, task.id);
        const result = await adapter.invoke(prompt, row.worktree, agent.model, row.session_id ?? undefined, signal, { root: this.root, agentId: agent.id });
        if (result.sessionId) this.state.db.prepare('UPDATE agents SET session_id=? WHERE id=?').run(result.sessionId, agent.id);
        if (this.state.tasks(phase.id).find(t => t.id === task.id)?.status !== 'complete') this.submitCheckpoint(agent.id, task.id, { summary: result.text.slice(0, 12000), tests: [], risks: [] });
        return { agent: agent.id, task: task.id, result: result.text };
      }));
      results.forEach((r, i) => { if (r.status === 'rejected') this.state.event(phase.id, batch[i]!.owner, 'agent_failure', { task: batch[i]!.id, message: String(r.reason) }); });
      allResults.push(...results);
      if (results.some(r => r.status === 'rejected')) break;
    }
    return allResults;
  }
  updateTask(agent: string, taskId: string, status: 'pending' | 'working' | 'blocked') {
    const row = this.state.db.prepare('SELECT owner,phase_id,status FROM tasks WHERE phase_id=? AND id=?').get(this.current().id, taskId) as { owner: string; phase_id: string; status: string } | undefined;
    if (!row || row.phase_id !== this.current().id || row.owner !== agent) throw new Error('Task ownership mismatch');
    if (row.status === 'complete') throw new Error('Completed tasks can only be reopened during integration recovery');
    this.state.db.prepare('UPDATE tasks SET status=? WHERE phase_id=? AND id=?').run(status, row.phase_id, taskId);
    this.state.event(row.phase_id, agent, 'task_updated', { taskId, status });
  }
  submitCheckpoint(agent: string, taskId: string, report: { summary: string; tests?: string[]; risks?: string[] }) {
    const phase = this.current();
    const state = this.state.phase(phase.id);
    if (!state || !['working', 'review'].includes(state.status)) throw new Error('Phase is not accepting checkpoints');
    const task = this.state.tasks(phase.id).find(t => t.id === taskId);
    if (!task || task.owner !== agent) throw new Error('Task ownership mismatch');
    const row = this.state.agents().find(a => a.id === agent)!;
    if (runSync('git', ['status', '--porcelain'], row.worktree)) throw new Error(`Uncommitted changes in ${agent} worktree`);
    const commit = this.git.verifyCommit(row.branch, state.foundation);
    this.git.assertContracts(state.foundation, row.branch, [...phase.contracts, '.agentmesh/collaboration-plan.json']);
    const files = this.git.changedFiles(state.foundation, row.branch);
    const record = { ...report, commit, files };
    this.state.transaction(() => {
      this.state.db.prepare('DELETE FROM reviews WHERE phase_id=? AND subject=?').run(phase.id, agent);
      this.state.db.prepare("UPDATE tasks SET status='complete',report=? WHERE phase_id=? AND id=?").run(JSON.stringify(record), phase.id, taskId);
      this.state.event(phase.id, agent, 'checkpoint', { taskId, ...record });
      if (this.state.tasks(phase.id).every(t => t.status === 'complete')) this.state.db.prepare("UPDATE phases SET status='review' WHERE id=?").run(phase.id);
    });
    return record;
  }
  report(agent: string, kind: 'blocker' | 'contract_conflict' | 'critical_discovery' | 'decision', body: string) {
    if (!this.plan.agents.some(a => a.id === agent)) throw new Error('Unknown agent');
    const phase = this.current();
    this.state.event(phase.id, agent, kind, { body });
    if (kind === 'blocker') for (const task of this.getTask(agent)) this.updateTask(agent, task.id, 'blocked');
    return { recorded: true, synchronizationRequired: kind !== 'decision' };
  }
  diff(agentId: string) {
    const phase = this.state.phase(this.current().id);
    const agent = this.state.agents().find(a => a.id === agentId);
    if (!phase || !agent) throw new Error('Unknown phase or agent');
    return this.git.diff(phase.foundation, agent.branch);
  }
  submitReview(reviewer: string, subject: string, verdict: 'approve' | 'changes_requested', body: string) {
    const phase = this.current();
    if (reviewer === subject || !this.plan.agents.some(a => a.id === reviewer) || !this.plan.agents.some(a => a.id === subject)) throw new Error('Review must be cross-agent');
    if (this.state.phase(phase.id)?.status !== 'review') throw new Error('Phase is not in review');
    const row = this.state.agents().find(a => a.id === subject)!;
    const commit = this.git.verifyCommit(row.branch, this.state.phase(phase.id)!.foundation);
    this.state.db.prepare('INSERT INTO reviews(phase_id,reviewer,subject,commit_sha,verdict,body) VALUES(?,?,?,?,?,?)').run(phase.id, reviewer, subject, commit, verdict, body);
    this.state.event(phase.id, reviewer, 'review', { subject, commit, verdict, body });
  }
  requiredReviews() {
    if (!this.plan.integration.requireReviews || this.plan.agents.length < 2) return 0;
    return this.plan.intensity === 'high' ? Math.min(2, this.plan.agents.length - 1) : 1;
  }
  async reviewAll() {
    const phase = this.current();
    if (this.state.phase(phase.id)?.status !== 'review') throw new Error('Phase is not in review');
    const results: { reviewer: string; subject: string; verdict?: string; error?: string }[] = [];
    for (const subject of this.plan.agents) {
      const subjectRow = this.state.agents().find(a => a.id === subject.id)!;
      const subjectHead = this.git.verifyCommit(subjectRow.branch, this.state.phase(phase.id)!.foundation);
      const candidates = this.plan.agents.filter(a => a.id !== subject.id && adapters[a.harness].detect().installed);
      candidates.sort((a, b) => Number(b.harness !== subject.harness) - Number(a.harness !== subject.harness));
      if (candidates.length < this.requiredReviews()) { results.push({ reviewer: 'none', subject: subject.id, error: 'Not enough available cross-agent reviewers' }); continue; }
      let approvals = 0;
      for (const reviewer of candidates) {
        const latest = this.state.db.prepare('SELECT commit_sha,verdict FROM reviews WHERE phase_id=? AND subject=? AND reviewer=? ORDER BY id DESC LIMIT 1').get(phase.id, subject.id, reviewer.id) as { commit_sha: string; verdict: string } | undefined;
        if (latest?.commit_sha === subjectHead) {
          results.push({ reviewer: reviewer.id, subject: subject.id, verdict: latest.verdict });
          if (latest.verdict === 'approve') approvals++;
          else break;
          if (approvals >= this.requiredReviews()) break;
          continue;
        }
        const row = this.state.agents().find(a => a.id === reviewer.id)!;
        const before = runSync('git', ['status', '--porcelain'], row.worktree);
        const head = runSync('git', ['rev-parse', 'HEAD'], row.worktree);
        if (before) { results.push({ reviewer: reviewer.id, subject: subject.id, error: 'Reviewer worktree is dirty' }); break; }
        try {
          const prompt = `Review ${subject.id}'s committed changes for correctness, safety, and task completion. Do not modify files. Return only JSON with keys verdict (approve or changes_requested) and body (concise findings).\nTask: ${JSON.stringify(this.getTask(subject.id))}\nDiff:\n${this.diff(subject.id)}`;
          const response = await adapters[reviewer.harness].invoke(prompt, row.worktree, reviewer.model, undefined, undefined, { root: this.root, agentId: reviewer.id }, 'review');
          if (runSync('git', ['status', '--porcelain'], row.worktree) !== before || runSync('git', ['rev-parse', 'HEAD'], row.worktree) !== head) throw new Error('Review modified reviewer worktree');
          const parsed = JSON.parse(response.text.slice(response.text.indexOf('{'), response.text.lastIndexOf('}') + 1));
          if (!['approve', 'changes_requested'].includes(parsed.verdict) || typeof parsed.body !== 'string') throw new Error('Invalid review response');
          this.submitReview(reviewer.id, subject.id, parsed.verdict, parsed.body);
          results.push({ reviewer: reviewer.id, subject: subject.id, verdict: parsed.verdict });
          if (parsed.verdict === 'approve') approvals++;
          else break;
          if (approvals >= this.requiredReviews()) break;
        } catch (error) { results.push({ reviewer: reviewer.id, subject: subject.id, error: String(error) }); break; }
      }
    }
    return results;
  }
  async runPhase(signal?: AbortSignal) {
    if (!this.current().validation.length) throw new Error('Configure at least one current-phase validation command before starting agents');
    this.begin();
    const phaseId = this.current().id;
    let agentResults: Awaited<ReturnType<Runtime['runAgents']>> = [];
    if (this.state.phase(phaseId)?.status === 'working') agentResults = await this.runAgents(signal);
    if (agentResults.some(r => r.status === 'rejected')) return { status: this.status(), agentResults, pending: 'agent failure' };
    if (this.state.phase(phaseId)?.status !== 'review') return { status: this.status(), agentResults, pending: 'checkpoint' };
    const reviewRounds: unknown[] = [];
    if (this.requiredReviews() > 0) {
      for (let round = 0; round < 3; round++) {
        const reviews = await this.reviewAll();
        reviewRounds.push(reviews);
        if (reviews.some(r => r.error)) return { status: this.status(), agentResults, reviewRounds, pending: 'review error' };
        const requested = [...new Set(reviews.filter(r => r.verdict === 'changes_requested').map(r => r.subject))];
        if (!requested.length) break;
        if (round === 2) return { status: this.status(), agentResults, reviewRounds, pending: 'review changes' };
        for (const subject of requested) await this.fixAgent(subject);
      }
    }
    const integration = await this.integrate();
    return { status: this.status(), agentResults, reviewRounds, integration };
  }
  async fixAgent(agentId: string) {
    const phase = this.current();
    if (this.state.phase(phase.id)?.status !== 'review') throw new Error('Phase is not in review');
    const agent = this.plan.agents.find(a => a.id === agentId);
    if (!agent) throw new Error('Unknown agent');
    const reviews = this.state.db.prepare('SELECT reviewer,verdict,body FROM reviews WHERE phase_id=? AND subject=? ORDER BY id DESC').all(phase.id, agentId) as { reviewer: string; verdict: string; body: string }[];
    const latest = new Map<string, (typeof reviews)[number]>();
    for (const review of reviews) if (!latest.has(review.reviewer)) latest.set(review.reviewer, review);
    if (![...latest.values()].some(review => review.verdict === 'changes_requested')) throw new Error('No requested changes for this agent');
    const row = this.state.agents().find(a => a.id === agentId)!;
    const prompt = `Address this checkpoint review in your own worktree. Commit fixes and report tests and risks. Keep frozen contracts unchanged.\n${JSON.stringify(this.checkpointContext(agentId))}`;
    const response = await adapters[agent.harness].invoke(prompt, row.worktree, agent.model, row.session_id ?? undefined, undefined, { root: this.root, agentId });
    if (response.sessionId) this.state.db.prepare('UPDATE agents SET session_id=? WHERE id=?').run(response.sessionId, agentId);
    const reports = this.getTask(agentId).map(task => this.submitCheckpoint(agentId, task.id, { summary: response.text.slice(0, 12000) }));
    return { agent: agentId, reports };
  }
  checkpointContext(agent: string) {
    const phase = this.current();
    return { phase: phase.id, tasks: this.state.tasks(phase.id).filter(t => t.owner !== agent),
      reviews: this.state.db.prepare('SELECT reviewer,subject,commit_sha,verdict,body FROM reviews WHERE phase_id=?').all(phase.id),
      exceptionalEvents: this.state.recentEvents(phase.id, 50).filter((e: any) => ['blocker', 'contract_conflict', 'critical_discovery'].includes(e.kind)) };
  }
  async integrate() {
    const phase = this.current(), state = this.state.phase(phase.id);
    if (!state || state.status !== 'review') throw new Error('Checkpoint review is not complete');
    const agents = this.state.agents();
    if (this.requiredReviews() > 0) {
      for (const subject of agents) {
        const reviews = this.state.db.prepare('SELECT reviewer,verdict,commit_sha FROM reviews WHERE phase_id=? AND subject=? ORDER BY id DESC').all(phase.id, subject.id) as { reviewer: string; verdict: string; commit_sha: string }[];
        const head = this.git.verifyCommit(subject.branch, state.foundation);
        const byReviewer = new Map<string, (typeof reviews)[number]>();
        for (const review of reviews) if (!byReviewer.has(review.reviewer)) byReviewer.set(review.reviewer, review);
        const latest = [...byReviewer.values()];
        if (latest.some(review => review.commit_sha === head && review.verdict === 'changes_requested') || latest.filter(review => review.commit_sha === head && review.verdict === 'approve').length < this.requiredReviews()) throw new Error(`${subject.id} needs ${this.requiredReviews()} current approval(s)`);
      }
    }
    if (!phase.validation.length) throw new Error('Configure at least one project validation command before integrating');
    for (const agent of agents) {
      const commit = this.git.verifyCommit(agent.branch, state.foundation);
      this.git.assertContracts(state.foundation, agent.branch, [...phase.contracts, '.agentmesh/collaboration-plan.json']);
      const reports = this.state.tasks(phase.id).filter(t => t.owner === agent.id);
      if (reports.some(t => !t.report || JSON.parse(t.report).commit !== commit)) throw new Error(`${agent.id} needs a checkpoint for its current commit`);
    }
    const claimed = this.state.db.prepare("UPDATE phases SET status='integrating' WHERE id=? AND status='review'").run(phase.id);
    if (claimed.changes !== 1) throw new Error('Another process already claimed integration');
    let commit: string | null = null;
    try {
      commit = this.git.integrate(agents.map(a => a.branch), state.foundation, this.plan.integration.branch);
      const output: string[] = [];
      for (const command of phase.validation) {
        const [exe, ...args] = command;
        const env = { ...process.env };
        delete env.NODE_TEST_CONTEXT;
        const result = await run(exe!, args, this.git.integrationPath(), { timeoutMs: 10 * 60 * 1000, env });
        output.push(`$ ${command.join(' ')}\n${result.stdout}\n${result.stderr}`);
      }
      this.state.transaction(() => {
        this.state.db.prepare("UPDATE phases SET status='complete', integration_commit=? WHERE id=?").run(commit, phase.id);
        this.state.db.prepare('INSERT INTO integrations(phase_id,commit_sha,status,output) VALUES(?,?,?,?)').run(phase.id, commit, 'passed', output.join('\n').slice(0, 100000));
        this.state.event(phase.id, null, 'integration_complete', { commit });
      });
      return { commit, output };
    } catch (error) {
      this.state.db.prepare("UPDATE phases SET status='failed' WHERE id=?").run(phase.id);
      this.state.db.prepare('INSERT INTO integrations(phase_id,commit_sha,status,output) VALUES(?,?,?,?)').run(phase.id, commit, 'failed', String(error));
      this.state.event(phase.id, null, 'integration_failed', { message: String(error) });
      throw error;
    }
  }
  recover() {
    const phase = this.current(), state = this.state.phase(phase.id);
    if (!state || state.status !== 'failed') throw new Error('Current phase has no failed integration');
    const backup = this.git.resetFailedIntegration(phase.id, state.foundation, this.plan.integration.branch);
    this.state.transaction(() => {
      this.state.db.prepare("UPDATE phases SET status='working' WHERE id=?").run(phase.id);
      this.state.db.prepare("UPDATE tasks SET status='pending',report=NULL WHERE phase_id=?").run(phase.id);
      this.state.db.prepare('DELETE FROM reviews WHERE phase_id=?').run(phase.id);
      this.state.event(phase.id, null, 'integration_recovered', { backup });
    });
    return { backup, phase: this.state.phase(phase.id) };
  }
  revisePlan(input: unknown) {
    const phase = this.current(), state = this.state.phase(phase.id);
    if (!state || state.status !== 'complete' || !state.integration_commit) throw new Error('Plan revisions require a completed integration');
    const proposed = validatePlan(input);
    if (proposed.currentPhase !== phase.id) throw new Error('Keep the current phase selected until advance');
    if (JSON.stringify(proposed.agents) !== JSON.stringify(this.plan.agents)) throw new Error('Agent roster cannot change during checkpoint revision');
    if (proposed.integration.branch !== this.plan.integration.branch) throw new Error('Integration branch cannot change during checkpoint revision');
    const completed = this.plan.phases.slice(0, this.plan.phases.findIndex(p => p.id === phase.id) + 1);
    if (JSON.stringify(proposed.phases.slice(0, completed.length)) !== JSON.stringify(completed)) throw new Error('Completed phase definitions cannot be rewritten');
    const path = this.git.integrationPath();
    if (runSync('git', ['status', '--porcelain'], path)) throw new Error('Integration checkout must be clean before revising the plan');
    writePlan(path, proposed);
    runSync('git', ['add', '--', '.agentmesh/collaboration-plan.json'], path);
    if (!runSync('git', ['diff', '--cached', '--name-only'], path)) return { changed: false, commit: runSync('git', ['rev-parse', 'HEAD'], path) };
    runSync('git', ['commit', '-m', 'agentmesh: revise collaboration plan'], path);
    const commit = runSync('git', ['rev-parse', 'HEAD'], path);
    this.state.event(phase.id, null, 'plan_revised', { commit });
    return { changed: true, commit };
  }
  advance() {
    const phase = this.state.phase(this.current().id);
    if (!phase || phase.status !== 'complete' || !phase.integration_commit) throw new Error('Current phase is not integrated');
    this.git.requireClean();
    if (this.git.head() !== phase.foundation) throw new Error('Main checkout moved since phase start; integrate manually');
    const integrationHead = this.git.call('rev-parse', this.plan.integration.branch);
    if (this.git.call('merge-base', phase.integration_commit, integrationHead) !== phase.integration_commit) throw new Error('Integration branch no longer descends from validated commit');
    const postValidationFiles = this.git.changedFiles(phase.integration_commit, this.plan.integration.branch);
    if (postValidationFiles.some(file => file !== '.agentmesh/collaboration-plan.json')) throw new Error('Code changed on integration branch after validation');
    const integratedPlan = readPlan(this.git.integrationPath());
    if (integratedPlan.currentPhase !== this.current().id) throw new Error('Integration plan changed the current phase before advance');
    if (JSON.stringify(integratedPlan.agents) !== JSON.stringify(this.plan.agents) || integratedPlan.integration.branch !== this.plan.integration.branch) throw new Error('Integration plan changed agent roster or branch');
    const index = integratedPlan.phases.findIndex(p => p.id === integratedPlan.currentPhase);
    if (JSON.stringify(integratedPlan.phases.slice(0, index + 1)) !== JSON.stringify(this.plan.phases.slice(0, index + 1))) throw new Error('Integration plan rewrote a completed phase');
    const next = integratedPlan.phases[index + 1];
    if (!next) throw new Error('No further phase is planned');
    this.git.call('merge', '--ff-only', this.plan.integration.branch);
    const updated: Plan = { ...integratedPlan, currentPhase: next.id };
    writePlan(this.root, updated);
    this.git.call('add', '--', '.agentmesh/collaboration-plan.json');
    this.git.call('commit', '-m', `agentmesh: begin ${next.id}`);
    runSync('git', ['merge', '--ff-only', this.git.head()], this.git.integrationPath());
    const cleanup: { agent: string; removed: boolean; error?: string }[] = [];
    for (const agent of this.plan.agents) {
      try { this.git.removeWorktree(this.current().id, agent.id); cleanup.push({ agent: agent.id, removed: true }); }
      catch (error) { cleanup.push({ agent: agent.id, removed: false, error: String(error) }); }
    }
    return { next: next.id, foundation: this.git.head(), cleanup };
  }
  status() { const phase = this.current(); return { phase: this.state.phase(phase.id), agents: this.state.agents(), tasks: this.state.tasks(phase.id), events: this.state.recentEvents(phase.id) }; }
}
