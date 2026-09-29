import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { State } from '../src/state.js';

test('legacy state migrates task keys to phase-scoped identities', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentmesh-state-'));
  try {
    mkdirSync(join(root, '.agentmesh'));
    const old = new DatabaseSync(join(root, '.agentmesh', 'state.sqlite'));
    old.exec(`CREATE TABLE phases(id TEXT PRIMARY KEY, status TEXT NOT NULL, foundation TEXT NOT NULL, integration_commit TEXT);
      CREATE TABLE agents(id TEXT PRIMARY KEY, harness TEXT NOT NULL, branch TEXT NOT NULL, worktree TEXT NOT NULL, session_id TEXT);
      CREATE TABLE tasks(id TEXT PRIMARY KEY, phase_id TEXT NOT NULL REFERENCES phases(id), owner TEXT NOT NULL REFERENCES agents(id), status TEXT NOT NULL, report TEXT);
      INSERT INTO phases(id,status,foundation) VALUES('phase-1','complete','abc'),('phase-2','working','def');
      INSERT INTO agents(id,harness,branch,worktree) VALUES('codex','codex','branch','path');
      INSERT INTO tasks(id,phase_id,owner,status) VALUES('codex-work','phase-1','codex','complete');`);
    old.close();
    const state = new State(root);
    try {
      state.db.prepare('INSERT INTO tasks(id,phase_id,owner,status) VALUES(?,?,?,?)').run('codex-work', 'phase-2', 'codex', 'pending');
      assert.equal(state.tasks('phase-1')[0]!.status, 'complete');
      assert.equal(state.tasks('phase-2')[0]!.status, 'pending');
      assert.equal((state.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 1);
    } finally { state.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('orchestration lock rejects a concurrent runner and releases after completion', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentmesh-lock-'));
  const first = new State(root), second = new State(root);
  try {
    let release!: () => void;
    const pending = first.withOrchestrationLock('run', () => new Promise<void>(resolve => { release = resolve; }));
    await assert.rejects(second.withOrchestrationLock('run', async () => {}), /Another AgentMesh process/);
    release();
    await pending;
    assert.equal(await second.withOrchestrationLock('run', async () => 'next'), 'next');
    await assert.rejects(second.withOrchestrationLock('run', async () => { throw new Error('failed'); }), /failed/);
    assert.equal(await first.withOrchestrationLock('run', async () => 'recovered'), 'recovered');
    first.db.prepare('INSERT INTO orchestration_locks(name,pid,token) VALUES(?,?,?)').run('run', 99999999, 'stale');
    assert.equal(await second.withOrchestrationLock('run', async () => 'after crash'), 'after crash');
  } finally { first.close(); second.close(); rmSync(root, { recursive: true, force: true }); }
});
