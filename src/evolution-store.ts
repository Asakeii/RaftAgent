import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import type { Evolution } from './evolution-contracts.js';
export class EvolutionStore {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path); chmodSync(path, 0o600);
    this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS evolutions(id TEXT PRIMARY KEY,evaluation_id TEXT NOT NULL,created_at TEXT NOT NULL,json TEXT NOT NULL); CREATE INDEX IF NOT EXISTS evolution_evaluation ON evolutions(evaluation_id,created_at);');
  }
  save(e: Evolution) { e.updatedAt = new Date().toISOString(); this.db.prepare('INSERT INTO evolutions VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(e.id,e.evaluationId,e.createdAt,JSON.stringify(e)); }
  get(id: string): Evolution { const row = this.db.prepare('SELECT json FROM evolutions WHERE id=?').get(id); if (!row) throw new Error('进化记录不存在。'); return JSON.parse(String(row.json)); }
  list(evaluationId: string): Evolution[] { return this.db.prepare('SELECT json FROM evolutions WHERE evaluation_id=? ORDER BY created_at DESC LIMIT 20').all(evaluationId).map(row => JSON.parse(String(row.json))); }
  unfinished(): Evolution[] { return this.db.prepare("SELECT json FROM evolutions WHERE json_extract(json,'$.status') IN ('generating','testing','promoting','rolling_back')").all().map(row => JSON.parse(String(row.json))); }
  close() { this.db.close(); }
}
