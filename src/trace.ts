import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { TraceRun, TraceEvent, SkillUsage } from './inspection-contracts.js';
import { calculateCostCny } from './model-pricing.js';
import { redact, inspectionText } from './inspection-redaction.js';

export class TraceStore {
  private db: DatabaseSync;
  warning = '';
  changed: () => void = () => {};
  constructor(path: string) {
    this.db = new DatabaseSync(path); chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS trace_runs (ordinal INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, agent_id TEXT NOT NULL, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS trace_runs_agent ON trace_runs(agent_id, ordinal);
      CREATE TABLE IF NOT EXISTS trace_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS trace_events_run ON trace_events(run_id,seq);
      CREATE TABLE IF NOT EXISTS trace_messages (message_id TEXT PRIMARY KEY, run_id TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS trace_messages_run ON trace_messages(run_id);`);
    // 仅在服务持有数据目录锁后创建；未收尾记录不伪装成功，也不重放执行。
    for (const row of this.db.prepare('SELECT json FROM trace_runs').all()) {
      const run = JSON.parse(String(row.json)) as TraceRun;
      if (run.status === 'running') this.update(run.id, { status: 'unknown', phase: '服务中断，执行结果待核验' });
    }
  }
  get(id: string): TraceRun | undefined {
    const row = this.db.prepare('SELECT json FROM trace_runs WHERE id=?').get(id);
    return row ? JSON.parse(String(row.json)) as TraceRun : undefined;
  }
  private write(fn: () => void) {
    try { fn(); this.changed(); } catch { this.warning = '部分执行日志保存失败；请检查数据目录，日志可能不完整。'; }
  }
  start(run: TraceRun) { this.write(() => { this.db.prepare('INSERT INTO trace_runs(id,agent_id,json) VALUES(?,?,?)').run(run.id, run.agentId, JSON.stringify(run)); }); }
  update(id: string, patch: Partial<TraceRun>) {
    this.write(() => { const run = this.get(id); if (run) this.db.prepare('UPDATE trace_runs SET json=? WHERE id=?').run(JSON.stringify({ ...run, ...patch }), id); });
  }
  append(event: Omit<TraceEvent, 'seq'>) {
    this.write(() => { this.db.prepare('INSERT INTO trace_events(run_id,json) VALUES(?,?)').run(event.runId, JSON.stringify({ ...event, traceId: this.get(event.runId)?.traceId })); });
  }
  linkMessage(messageId: string, runId: string) {
    this.write(() => { this.db.prepare('INSERT OR IGNORE INTO trace_messages(message_id,run_id) VALUES(?,?)').run(messageId, runId); });
  }
  private scopedRuns(agentId: string, channel?: string) {
    return this.db.prepare('SELECT json FROM trace_runs WHERE agent_id=? ORDER BY ordinal DESC').all(agentId)
      .map(row => JSON.parse(String(row.json)) as TraceRun)
      .filter(run => channel === undefined || (channel === 'legacy' ? run.contextVersion !== 1 : run.contextVersion === 1 && run.channel === channel));
  }
  list(agentId: string, before?: string, limit = 30, channel?: string): { runs: TraceRun[]; nextBefore: string | null } {
    const all = this.scopedRuns(agentId, channel);
    const start = before ? all.findIndex(run => run.id === before) + 1 : 0;
    const runs = all.slice(start, start + limit);
    return { runs, nextBefore: start + limit < all.length ? runs.at(-1)!.id : null };
  }
  sessions(agentId: string, channel?: string): { sessions: string[]; runInputs: Map<string, string> } {
    const runs = this.scopedRuns(agentId, channel);
    const ids = new Set(runs.map(r => r.id));
    const links = this.db.prepare('SELECT message_id,run_id FROM trace_messages JOIN trace_runs ON trace_messages.run_id=trace_runs.id WHERE agent_id=?').all(agentId).filter(r => ids.has(String(r.run_id)));
    return { sessions: [...new Set(runs.flatMap(r => r.sessionId ? [r.sessionId] : []))], runInputs: new Map([...runs.map(r => [r.inputId, r.id] as [string, string]), ...links.map(r => [String(r.message_id), String(r.run_id)] as [string, string])]) };
  }
  events(id: string, after = 0, limit = 200): { events: TraceEvent[]; nextAfter: number | null } {
    const rows = this.db.prepare('SELECT seq,json FROM trace_events WHERE run_id=? AND seq>? ORDER BY seq LIMIT ?').all(id, after, limit + 1);
    const events = rows.slice(0, limit).map(row => ({ ...JSON.parse(String(row.json)), seq: Number(row.seq) } as TraceEvent));
    return { events, nextAfter: rows.length > limit ? events.at(-1)!.seq : null };
  }
  related(traceId: string): TraceRun[] {
    return this.db.prepare("SELECT json FROM trace_runs WHERE json_extract(json,'$.traceId')=? ORDER BY ordinal").all(traceId).map(row => JSON.parse(String(row.json)) as TraceRun);
  }
  hasScriptRequest(runId: string, requestId: string) {
    return Boolean(this.db.prepare("SELECT 1 FROM trace_events WHERE run_id=? AND json_extract(json,'$.kind')='script.start' AND json_extract(json,'$.detail.requestId')=? LIMIT 1").get(runId, requestId));
  }
  scriptRequestStatus(agentId: string, requestId: string) {
    const row = this.db.prepare(`SELECT e.json FROM trace_events e JOIN trace_runs r ON r.id=e.run_id
      WHERE r.agent_id=? AND json_extract(e.json,'$.kind') IN ('script.start','script.end')
      AND json_extract(e.json,'$.detail.requestId')=? ORDER BY e.seq DESC LIMIT 1`).get(agentId, requestId);
    if (!row) return undefined;
    const event = JSON.parse(String(row.json)) as TraceEvent;
    const detail = event.detail as Record<string, unknown>;
    return { requestId, runId: event.runId, status: event.kind === 'script.end' ? detail.status : 'unknown',
      exitCode: event.kind === 'script.end' ? detail.exitCode : null, businessStatus: 'not_verified',
      instruction: event.kind === 'script.end' ? '这是进程回执，业务结果仍需核验。' : '已授权但尚无完成回执；可能仍在执行或已经执行，禁止盲目重新运行。' };
  }
  skillUsage(runId: string): SkillUsage[] {
    const groups = new Map<string, SkillUsage>();
    // Read the whole run, independent of event-page limits.
    for (const row of this.db.prepare('SELECT json FROM trace_events WHERE run_id=? ORDER BY seq').all(runId)) {
      const event = JSON.parse(String(row.json)) as TraceEvent;
      const d = event.detail as Record<string, unknown> | undefined;
      if (!d || typeof d.skillId !== 'string' || typeof d.skillVersion !== 'string') continue;
      const key = JSON.stringify([d.skillId, d.skillVersion]);
      let usage = groups.get(key);
      if (!usage) {
        usage = { skillId: d.skillId, skillVersion: d.skillVersion, skillName: String(d.skillName ?? d.skillId), loaded: 0, loadFailed: 0, serviceReturned: 0, serviceFailed: 0, replayed: 0, processSucceeded: 0, processFailed: 0, incomplete: 0, state: 'unknown' };
        groups.set(key, usage);
      }
      if (['skill.load.start', 'capability.start', 'script.start'].includes(event.kind)) usage.incomplete++;
      if (['skill.loaded', 'skill.load.failed', 'capability.end', 'script.end'].includes(event.kind)) usage.incomplete--;
      if (event.kind === 'skill.loaded') usage.loaded++;
      if (event.kind === 'skill.load.failed') usage.loadFailed++;
      if (event.kind === 'capability.end') {
        if (d.replayed === true) usage.replayed++;
        else if (d.outcome === 'failed') usage.serviceFailed++;
        else usage.serviceReturned++;
      }
      if (event.kind === 'script.end') {
        if (d.status === 'process_succeeded') usage.processSucceeded++;
        else usage.processFailed++;
      }
    }
    return [...groups.values()].map(u => ({ ...u, incomplete: Math.max(0, u.incomplete), state: u.serviceReturned + u.serviceFailed + u.processSucceeded + u.processFailed > 0 ? 'execution_observed' : u.loaded > 0 && u.incomplete === 0 ? 'loaded_only' : 'unknown' }));
  }
  close() { this.db.close(); }
}

/** 只观察 SDK 事件；任何采集失败都不能改变工具权限或调度结果。 */
export class RunObserver {
  private tools = new Map<string, number>();
  private seen = new Set<string>();
  constructor(private store: TraceStore, readonly runId: string, private secrets: string[]) {}
  event(kind: string, summary: string, detail?: unknown, extra: Partial<Pick<TraceEvent, 'level' | 'toolId' | 'durationMs'>> = {}) {
    let safe = redact(detail, this.secrets);
    if (JSON.stringify(safe)?.length > 64_000) safe = { preview: inspectionText(JSON.stringify(safe)) };
    this.store.append({ runId: this.runId, at: new Date().toISOString(), kind, level: 'info', summary: inspectionText(summary, this.secrets), ...(safe === undefined ? {} : { detail: safe }), ...extra });
  }
  phase(phase: string) { this.store.update(this.runId, { phase }); }
  toolStart(id: string, name: string, input: unknown) {
    this.tools.set(id, Date.now()); this.phase(`调用 ${name}`);
    this.event('tool.start', `调用 ${name}`, input, { toolId: id });
  }
  toolEnd(id: string, name: string, output: unknown, failed: boolean) {
    const start = this.tools.get(id); this.tools.delete(id);
    this.event(failed ? 'tool.error' : 'tool.end', `${name} ${failed ? '失败' : '已返回'}`, output, { toolId: id, level: failed ? 'error' : 'info', ...(start !== undefined ? { durationMs: Date.now() - start } : {}) });
    this.phase(this.tools.size ? '工具执行中' : '等待模型响应');
  }
  message(message: SDKMessage) {
    if ((message.type === 'assistant' || message.type === 'user' || message.type === 'system') && message.uuid) this.store.linkMessage(message.uuid, this.runId);
    if (message.type === 'system' && message.subtype === 'init') {
      this.store.update(this.runId, { sessionId: message.session_id, phase: '等待模型响应' });
      this.event('session.init', 'SDK 会话已就绪', { sessionId: message.session_id, model: message.model });
    } else if (message.type === 'system' && message.subtype === 'api_retry') {
      this.phase(`API 重试 ${message.attempt}/${message.max_retries}`);
      this.event('api.retry', `API 请求失败，${Math.ceil(message.retry_delay_ms / 1000)} 秒后重试`, { attempt: message.attempt, maxRetries: message.max_retries, status: message.error_status, error: message.error, retryDelayMs: message.retry_delay_ms }, { level: 'warn' });
    } else if (message.type === 'system' && message.subtype === 'compact_boundary') {
      this.event('context.compact', 'SDK 已压缩上下文', message.compact_metadata);
    } else if (message.type === 'stream_event' && message.event.type === 'message_start') {
      this.phase('模型正在生成');
      this.event('model.response', '开始接收模型响应', { messageId: message.event.message.id, model: message.event.message.model });
    } else if (message.type === 'tool_progress') {
      this.phase(`${message.tool_name} · 已执行 ${Math.round(message.elapsed_time_seconds)} 秒`);
    } else if (message.type === 'assistant' && !this.seen.has(message.uuid)) {
      this.seen.add(message.uuid);
      this.event('assistant.message', message.error ? '模型返回错误' : '模型输出', { messageId: message.message.id, blocks: message.message.content }, { level: message.error ? 'error' : 'info' });
    } else if (message.type === 'result') {
      const pricing = this.store.get(this.runId)?.pricing;
      const costCny = pricing ? calculateCostCny(message.modelUsage, pricing) : undefined;
      this.store.update(this.runId, { durationMs: message.duration_ms, apiDurationMs: message.duration_api_ms, turns: message.num_turns, usage: redact(message.modelUsage, this.secrets), estimatedCostUsd: message.total_cost_usd, costCny });
      this.event('run.result', message.is_error || message.subtype !== 'success' ? 'SDK 执行未成功' : 'SDK 本轮结束', { subtype: message.subtype, isError: message.is_error, stopReason: message.stop_reason, permissionDenials: message.permission_denials }, { level: message.is_error || message.subtype !== 'success' ? 'error' : 'info' });
    }
  }
  finish(status: 'done' | 'error' | 'stopped', error?: string) {
    this.store.update(this.runId, { status, phase: status === 'done' ? '执行结束' : status === 'stopped' ? '已停止' : '执行失败', endedAt: new Date().toISOString(), ...(error ? { error: inspectionText(error, this.secrets) } : {}) });
    this.event('run.end', status === 'done' ? '执行结束' : status === 'stopped' ? '用户停止执行' : '执行失败', error, { level: status === 'error' ? 'error' : status === 'stopped' ? 'warn' : 'info' });
  }
}
