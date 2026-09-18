import type { Actor, Command } from './contracts.js';
import type { SkillManager } from './skills.js';
import type { TraceStore } from './trace.js';
import { DomainError } from './domain-error.js';

type Identity = NonNullable<ReturnType<SkillManager['traceSkill']>>;
type Script = ReturnType<SkillManager['scriptEntry']>;
/** Execution evidence belongs to the authenticated run; client trace IDs are never trusted. */
export class SkillExecutionTrace {
  private scripts = new Map<string, { entry: Script; started: number; result?: { status: string; exitCode: number | null } }>();
  constructor(private traces: TraceStore, private skills: SkillManager) {}
  private event(runId: string, kind: string, detail: unknown, failed = false) {
    this.traces.append({ runId, at: new Date().toISOString(), kind, level: failed ? 'error' : 'info',
      summary: kind === 'capability.start' ? '能力执行已开始' : kind === 'capability.end' ? '能力执行已返回' : '脚本执行回执', detail });
  }
  commandSkill(agentId: string, name: string): Identity | undefined {
    // Explicit ownership, never attribute commands to the most recently loaded Skill.
    const owner = name.startsWith('web.') ? 'raft:tavily-search' : /^(room|inbox|message|draft|task|activity|agent|skill)\./.test(name) || name === 'view_inbox' ? 'raft:raft-collaboration' : undefined;
    return owner ? this.skills.traceSkill(agentId, owner) : undefined;
  }
  async execute<T>(actor: Extract<Actor, { kind: 'agent' }>, command: Command, action: () => Promise<T>, replayed = () => false): Promise<T> {
    const started = Date.now();
    const detail = { ...this.commandSkill(actor.agentId, command.name), command: command.name, requestId: command.requestId, evidence: 'service_handler' };
    this.event(actor.runId, 'capability.start', detail);
    try {
      const result = await action();
      const value = result && typeof result === 'object' ? result as Record<string, unknown> : {};
      // CLI transport success is not necessarily a committed business operation.
      this.event(actor.runId, 'capability.end', { ...detail, outcome: 'returned', replayed: replayed(), businessStatus: typeof value.status === 'string' ? value.status.slice(0, 100) : 'not_reported', durationMs: Date.now() - started });
      return result;
    } catch (error) {
      this.event(actor.runId, 'capability.end', { ...detail, outcome: 'failed', durationMs: Date.now() - started }, true);
      throw error;
    }
  }
  script(actor: Extract<Actor, { kind: 'agent' }>, command: Command) {
    for (const [key] of this.scripts) if (this.traces.get(key.split(':')[0]!)?.status !== 'running') this.scripts.delete(key);
    const id = command.requestId;
    if (!id || id.length > 150 || id.includes(':')) throw new DomainError('脚本执行需要有效 request-id');
    const key = `${actor.runId}:${id}`;
    if (command.name === 'skill.script.start') {
      if (this.scripts.has(key) || this.traces.scriptRequestStatus(actor.agentId, id)) throw new DomainError('脚本请求已使用，禁止自动重复执行');
      if (this.scripts.size >= 1000) throw new DomainError('脚本追踪容量已满');
      const entry = this.skills.scriptEntry(actor.agentId, command.args.name, command.args.script);
      if (!/\.(py|sh|js|mjs|cjs)$/.test(entry.path)) throw new DomainError('脚本仅支持 py/sh/js/mjs/cjs');
      this.scripts.set(key, { entry, started: Date.now() });
      const { path: _path, ...identity } = entry;
      this.event(actor.runId, 'script.start', { ...identity, requestId: id, outcome: 'authorized', evidence: 'runner_receipt' });
      if (!this.traces.hasScriptRequest(actor.runId, id)) { this.scripts.delete(key); throw new DomainError('脚本授权日志未保存，未执行脚本'); }
      return { ...entry, traceId: this.traces.get(actor.runId)?.traceId, runId: actor.runId };
    }
    const pending = this.scripts.get(key);
    if (!pending) throw new DomainError('没有对应的脚本执行');
    const exitCode = command.args.exitCode;
    if (exitCode !== null && (!Number.isInteger(exitCode) || Number(exitCode) < 0 || Number(exitCode) > 255)) throw new DomainError('exitCode 无效');
    if (pending.result) {
      if (pending.result.exitCode !== exitCode) throw new DomainError('脚本回执与原结果冲突');
      return pending.result;
    }
    const { path: _path, ...identity } = pending.entry;
    pending.result = { status: exitCode === 0 ? 'process_succeeded' : 'process_failed', exitCode: exitCode as number | null };
    this.event(actor.runId, 'script.end', { ...identity, requestId: id, ...pending.result as object, durationMs: Date.now() - pending.started, evidence: 'runner_receipt', businessStatus: 'not_verified' }, exitCode !== 0);
    return pending.result;
  }
}
