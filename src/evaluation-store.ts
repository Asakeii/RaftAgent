import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import type { Evaluation } from './evaluation-contracts.js';

export class EvaluationStore {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path); chmodSync(path, 0o600);
    this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS evaluations (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, created_at TEXT NOT NULL, json TEXT NOT NULL); CREATE INDEX IF NOT EXISTS evaluation_run ON evaluations(run_id, created_at);');
    for (const row of this.db.prepare('SELECT json FROM evaluations').all()) {
      const evaluation = JSON.parse(String(row.json)) as Evaluation;
      if (evaluation.status === 'running') this.save({ ...evaluation, status: 'interrupted', verdict: 'inconclusive', costComplete: false, endedAt: new Date().toISOString(), error: '服务中断，未完成评测；可重新评测，历史结果保留。' });
    }
  }
  save(value: Evaluation) {
    this.db.prepare('INSERT INTO evaluations VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(value.id, value.runId, value.createdAt, JSON.stringify(value));
  }
  get(id: string): Evaluation | undefined {
    const row = this.db.prepare('SELECT json FROM evaluations WHERE id=?').get(id);
    return row ? JSON.parse(String(row.json)) as Evaluation : undefined;
  }
  list(runId: string): Evaluation[] {
    return this.db.prepare('SELECT json FROM evaluations WHERE run_id=? ORDER BY created_at DESC LIMIT 30').all(runId).map(r => JSON.parse(String(r.json)) as Evaluation);
  }
  close() { this.db.close(); }
}
