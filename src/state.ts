import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export type PhaseStatus = 'planned' | 'working' | 'review' | 'integrating' | 'complete' | 'failed';
export class State {
  readonly db: DatabaseSync;
  constructor(root: string) {
    mkdirSync(join(root, '.agentmesh'), { recursive: true });
    this.db = new DatabaseSync(join(root, '.agentmesh', 'state.sqlite'));
    try {
    const schemaVersion = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (schemaVersion > 1) throw new Error(`AgentMesh state schema ${schemaVersion} is newer than this runtime`);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=30000;
      CREATE TABLE IF NOT EXISTS phases(id TEXT PRIMARY KEY, status TEXT NOT NULL, foundation TEXT NOT NULL, integration_commit TEXT);
      CREATE TABLE IF NOT EXISTS agents(id TEXT PRIMARY KEY, harness TEXT NOT NULL, branch TEXT NOT NULL, worktree TEXT NOT NULL, session_id TEXT);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT NOT NULL, phase_id TEXT NOT NULL REFERENCES phases(id), owner TEXT NOT NULL REFERENCES agents(id), status TEXT NOT NULL, report TEXT, PRIMARY KEY(phase_id,id));
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, phase_id TEXT NOT NULL, agent_id TEXT, kind TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS reviews(id INTEGER PRIMARY KEY AUTOINCREMENT, phase_id TEXT NOT NULL, reviewer TEXT NOT NULL, subject TEXT NOT NULL, commit_sha TEXT NOT NULL, verdict TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS integrations(id INTEGER PRIMARY KEY AUTOINCREMENT, phase_id TEXT NOT NULL, commit_sha TEXT, status TEXT NOT NULL, output TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS orchestration_locks(name TEXT PRIMARY KEY, pid INTEGER NOT NULL, token TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    `);
    if (schemaVersion === 0) {
      const columns = this.db.prepare('PRAGMA table_info(tasks)').all() as { name: string; pk: number }[];
      const idKey = columns.find(column => column.name === 'id')?.pk;
      const phaseKey = columns.find(column => column.name === 'phase_id')?.pk;
      if (idKey === 1 && phaseKey === 0) {
        this.db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE tasks_new(id TEXT NOT NULL, phase_id TEXT NOT NULL REFERENCES phases(id), owner TEXT NOT NULL REFERENCES agents(id), status TEXT NOT NULL, report TEXT, PRIMARY KEY(phase_id,id));
          INSERT INTO tasks_new(id,phase_id,owner,status,report) SELECT id,phase_id,owner,status,report FROM tasks;
          DROP TABLE tasks;
          ALTER TABLE tasks_new RENAME TO tasks;
          COMMIT;`);
      }
      this.db.exec('PRAGMA user_version=1');
    }
    const integrity = this.db.prepare('PRAGMA quick_check').get() as { quick_check: string };
    if (integrity.quick_check !== 'ok') throw new Error(`AgentMesh state database integrity check failed: ${integrity.quick_check}`);
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* no active transaction */ }
      try { this.db.close(); } catch { /* preserve initial error */ }
      throw error;
    }
  }
  close() { this.db.close(); }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { try { this.db.exec('ROLLBACK'); } catch { /* preserve initial error */ } throw error; }
  }
  phase(id: string) { return this.db.prepare('SELECT * FROM phases WHERE id=?').get(id) as { id: string; status: PhaseStatus; foundation: string; integration_commit: string | null } | undefined; }
  agents() { return this.db.prepare('SELECT * FROM agents').all() as { id: string; harness: string; branch: string; worktree: string; session_id: string | null }[]; }
  tasks(phase: string) { return this.db.prepare('SELECT * FROM tasks WHERE phase_id=?').all(phase) as { id: string; phase_id: string; owner: string; status: string; report: string | null }[]; }
  event(phase: string, agent: string | null, kind: string, body: unknown) { this.db.prepare('INSERT INTO events(phase_id,agent_id,kind,body) VALUES(?,?,?,?)').run(phase, agent, kind, JSON.stringify(body)); }
  events(phase: string) { return this.db.prepare('SELECT * FROM events WHERE phase_id=? ORDER BY id').all(phase); }
  recentEvents(phase: string, limit = 50) { return this.db.prepare('SELECT * FROM events WHERE phase_id=? ORDER BY id DESC LIMIT ?').all(phase, limit).reverse(); }
  async withOrchestrationLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const token = randomUUID();
    this.transaction(() => {
      const existing = this.db.prepare('SELECT pid FROM orchestration_locks WHERE name=?').get(name) as { pid: number } | undefined;
      if (existing) {
        let alive = false;
        try { process.kill(existing.pid, 0); alive = true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') alive = true; }
        if (alive) throw new Error(`Another AgentMesh process (${existing.pid}) is running ${name}`);
        this.db.prepare('DELETE FROM orchestration_locks WHERE name=?').run(name);
      }
      this.db.prepare('INSERT INTO orchestration_locks(name,pid,token) VALUES(?,?,?)').run(name, process.pid, token);
    });
    try { return await fn(); }
    finally { this.db.prepare('DELETE FROM orchestration_locks WHERE name=? AND token=?').run(name, token); }
  }
}
