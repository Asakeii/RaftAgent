import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_EVALUATOR, type Evaluation, type EvaluationEvidence, type EvaluationProfile, type EvaluationRule, type RuleState } from './evaluation-contracts.js';
import { EvaluationStore } from './evaluation-store.js';
import { judgeOptions, runJudge, type JudgeRunner } from './evaluation-judge.js';
import type { TraceStore } from './trace.js';
import type { Store } from './store.js';
import type { ModelSettings } from './model-settings.js';
import { DomainError } from './domain-error.js';
import { inspectionText } from './inspection-redaction.js';

export function evidenceWindows(evidence: EvaluationEvidence[]): EvaluationEvidence[][] {
  const result: EvaluationEvidence[][] = [];
  for (let start = 0; start < evidence.length; start += DEFAULT_EVALUATOR.windowSize - DEFAULT_EVALUATOR.overlap) {
    result.push(evidence.slice(start, start + DEFAULT_EVALUATOR.windowSize));
    if (start + DEFAULT_EVALUATOR.windowSize >= evidence.length) break;
  }
  return result;
}
export function validateRuleStates(output: unknown, previous: RuleState[], evidence: EvaluationEvidence[]): RuleState[] {
  const rows = (output as { rules?: unknown } | null)?.rules;
  if (!Array.isArray(rows) || rows.length !== previous.length) throw new Error('裁判返回的规则数量不匹配。');
  const seen = new Set<string>();
  const allowed = new Set([...evidence.map(e => e.id), ...previous.flatMap(s => s.evidenceRefs)]);
  for (const row of rows) {
    if (!row || typeof row !== 'object' || !previous.some(s => s.id === row.ruleId) || seen.has(row.ruleId)) throw new Error('裁判返回了重复或未知规则。');
    seen.add(row.ruleId);
    if (!['pass', 'fail', 'unknown'].includes(row.verdict) || typeof row.reason !== 'string' || !row.reason.trim() || row.reason.length > 1600 || !Array.isArray(row.evidenceRefs) || row.evidenceRefs.length > 8 || row.evidenceRefs.some((id: unknown) => typeof id !== 'string' || !allowed.has(id))) throw new Error('裁判结果格式或证据引用无效。');
    if (row.verdict !== 'unknown' && !row.evidenceRefs.length) throw new Error('通过/失败判断必须引用可核查证据。');
  }
  return previous.map(rule => {
    const row = rows.find(r => r.ruleId === rule.id)!;
    return { ...rule, verdict: row.verdict, reason: row.reason.trim(), evidenceRefs: [...new Set<string>(row.evidenceRefs)] };
  });
}
export function evaluationVerdict(states: RuleState[], incomplete: boolean): Evaluation['verdict'] {
  if (incomplete) return 'inconclusive';
  const required = states.filter(r => r.required);
  if (required.some(r => r.verdict === 'fail')) return 'fail';
  return required.length && required.every(r => r.verdict === 'pass') ? 'pass' : 'inconclusive';
}
function parseRequest(input: unknown): { objective: string; rules: EvaluationRule[]; scope: Evaluation['scope'] } {
  const value = input as { objective?: unknown; rules?: unknown; scope?: unknown } | null;
  if (!value || typeof value.objective !== 'string' || !value.objective.trim() || value.objective.length > 8000) throw new DomainError('请填写任务目标（1–8000 字符）。');
  if (value.scope !== undefined && value.scope !== 'run' && value.scope !== 'trace') throw new DomainError('评测范围无效。');
  if (!Array.isArray(value.rules) || !value.rules.length || value.rules.length > 20) throw new DomainError('请提供 1–20 条验收规则。');
  const rules = value.rules.map((row, i) => {
    if (!row || typeof row.text !== 'string' || !row.text.trim() || row.text.length > 1000 || typeof row.required !== 'boolean') throw new DomainError('规则须含 1–1000 字符的描述和是否必须通过。');
    return { id: `r${i + 1}`, text: row.text.trim(), required: row.required };
  });
  if (!rules.some(r => r.required)) throw new DomainError('至少需要一条必须通过的规则。');
  return { objective: value.objective.trim(), rules, scope: value.scope === 'trace' ? 'trace' : 'run' };
}

export class EvaluationService {
  readonly store: EvaluationStore;
  private cwd: string;
  private active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private closing = false;
  constructor(dataDir: string, private traces: TraceStore, private state: Store, private settings: ModelSettings, private runner: JudgeRunner = runJudge) {
    this.cwd = join(dataDir, 'evaluation-workspace'); mkdirSync(this.cwd, { recursive: true, mode: 0o700 });
    this.store = new EvaluationStore(join(dataDir, 'evaluations.sqlite'));
  }
  profile(): EvaluationProfile {
    const settings = this.settings.view();
    return { ...DEFAULT_EVALUATOR, model: settings.evaluatorModel || settings.model || 'SDK 默认模型', ready: settings.hasApiKey };
  }
  private snapshot(runId: string, scope: Evaluation['scope'], secrets: string[]) {
    const anchor = this.traces.get(runId);
    if (!anchor) throw new DomainError('执行记录不存在。');
    const runs = scope === 'trace' ? this.traces.related(anchor.traceId) : [anchor];
    if (runs.some(r => r.status === 'running')) throw new DomainError('请等待所选范围内的运行结束后再评测。');
    const evidence: EvaluationEvidence[] = [];
    const add = (id: string, rid: string, at: string, kind: string, value: unknown) => {
      const raw = inspectionText(value, secrets);
      const truncated = raw.length > 6000 || /已截断|内容超过|其余条目/.test(raw);
      const text = raw.length > 6000 ? `${raw.slice(0, 4500)}\n[中间内容已截断]\n${raw.slice(-1500)}` : raw;
      evidence.push({ id, runId: rid, at, kind, text, truncated });
      if (evidence.length > 800) throw new DomainError('本次轨迹超过 800 条证据，请改为单次运行评测。');
    };
    for (const run of runs) {
      add(`run:${run.id}`, run.id, run.startedAt, 'run.context', { prompt: run.prompt, status: run.status, channel: run.channel, model: run.model, error: run.error });
      let after = 0;
      do {
        const page = this.traces.events(run.id, after, 200);
        for (const event of page.events) add(`event:${event.seq}`, run.id, event.at, event.kind, { summary: event.summary, detail: event.detail });
        if (page.nextAfter === null) break;
        after = page.nextAfter;
      } while (true);
    }
    const ids = new Set(runs.map(r => r.id));
    for (const message of this.state.state.messages) if (message.runId && ids.has(message.runId)) add(`message:${message.id}`, message.runId, message.at, 'published.message', { channel: message.channel, text: message.text, retractedAt: message.retractedAt, delivery: message.delivery });
    for (const draft of this.state.state.drafts) if (draft.runId && ids.has(draft.runId)) add(`draft:${draft.id}`, draft.runId, runs.find(r => r.id === draft.runId)!.endedAt ?? anchor.startedAt, 'draft.state', draft);
    evidence.sort((a, b) => a.at.localeCompare(b.at));
    if (JSON.stringify(evidence).length > 2_000_000) throw new DomainError('轨迹过大，请缩小评测范围。');
    return { runs, evidence };
  }
  start(runId: string, input: unknown): Evaluation {
    if (this.closing) throw new DomainError('评测服务正在关闭。');
    if (this.active.size >= 2) throw new DomainError('已有两项评测正在运行，请稍后重试。');
    if ([...this.active.keys()].some(id => this.store.get(id)?.runId === runId)) throw new DomainError('该运行已有评测进行中。');
    const request = parseRequest(input);
    const profile = this.profile();
    if (!profile.ready) throw new DomainError('请先在设置中配置模型 API Key。');
    const env = { ...this.settings.env };
    if (this.settings.view().evaluatorModel) env.ANTHROPIC_MODEL = this.settings.view().evaluatorModel;
    const secrets = [env.ANTHROPIC_API_KEY ?? '', env.ANTHROPIC_AUTH_TOKEN ?? ''];
    const { runs, evidence } = this.snapshot(runId, request.scope, secrets);
    const warnings = ['仅基于保存的轨迹评测，未独立读取或验收真实文件、数据库与外部副作用。'];
    if (evidence.some(e => e.truncated)) warnings.push('部分证据已截断，整体结论不会判为通过。');
    if (runs.some(r => r.status === 'unknown') || this.traces.warning) warnings.push('原运行或日志完整性待核验，整体结论不会判为通过。');
    const now = new Date().toISOString();
    const value: Evaluation = {
      id: randomUUID(), agentId: this.traces.get(runId)!.agentId, runId, scope: request.scope,
      objective: inspectionText(request.objective, secrets), profile, sourceRunIds: runs.map(r => r.id), evidence,
      evidenceHash: createHash('sha256').update(JSON.stringify(evidence)).digest('hex'),
      status: 'running', verdict: 'inconclusive',
      states: request.rules.map(r => ({ ...r, text: inspectionText(r.text, secrets), verdict: 'unknown', reason: '尚未评测', evidenceRefs: [] })),
      windows: [], totalWindows: evidenceWindows(evidence).length, createdAt: now, warnings, costUsd: 0, costComplete: true,
    };
    this.store.save(value);
    const controller = new AbortController();
    const item = { controller, done: Promise.resolve() };
    this.active.set(value.id, item);
    // Capture model configuration and evidence before yielding; later settings edits cannot alter a running evaluation.
    item.done = this.evaluate(value, env, controller, secrets)
      .catch(() => { console.error('评测记录持久化失败，请检查数据目录；未保存的结果不可用于验收。'); })
      .finally(() => this.active.delete(value.id));
    return this.store.get(value.id)!;
  }
  private async evaluate(value: Evaluation, env: NodeJS.ProcessEnv, controller: AbortController, secrets: string[]) {
    const timeout = setTimeout(() => controller.abort(new Error('评测超过 10 分钟时限。')), 600_000);
    try {
      const windows = evidenceWindows(value.evidence);
      for (const [index, evidence] of windows.entries()) {
        controller.signal.throwIfAborted();
        const remaining = DEFAULT_EVALUATOR.maxCostUsd - value.costUsd;
        if (remaining <= 0) throw new Error('评测已达到 2 美元 SDK 估算预算。');
        const started = Date.now();
        const prompt = JSON.stringify({ objective: value.objective, rules: value.states, window: index + 1, totalWindows: windows.length, finalWindow: index === windows.length - 1, scope: value.scope, sourceRunIds: value.sourceRunIds, warnings: value.warnings, evidence });
        const result = await this.runner(prompt, judgeOptions(env, this.cwd, controller, value.states.map(r => r.id), remaining));
        controller.signal.throwIfAborted();
        if (!Number.isFinite(result.costUsd) || result.costUsd < 0) throw new Error('裁判用量缺失，无法继续控制预算。');
        value.costUsd += result.costUsd;
        const states = validateRuleStates(result.output, value.states, evidence).map(s => ({ ...s, reason: inspectionText(s.reason, secrets) }));
        value.states = states;
        value.windows.push({ index: index + 1, evidenceIds: evidence.map(e => e.id), states: structuredClone(states), costUsd: result.costUsd, durationMs: Date.now() - started });
        this.store.save(value);
      }
      value.status = 'completed';
      const incomplete = value.warnings.length > 1;
      value.verdict = evaluationVerdict(value.states, false);
      if (incomplete && value.verdict === 'pass') value.verdict = 'inconclusive';
    } catch (error) {
      value.status = controller.signal.aborted ? 'cancelled' : 'failed';
      value.verdict = 'inconclusive'; value.costComplete = false;
      value.error = inspectionText(controller.signal.aborted ? controller.signal.reason?.message || '评测已停止，当前窗口费用可能未返回。' : error instanceof Error ? error.message : '评测失败。', secrets);
    } finally {
      clearTimeout(timeout); value.endedAt = new Date().toISOString(); this.store.save(value);
    }
  }
  cancel(id: string, runId: string) {
    const value = this.store.get(id);
    if (!value || value.runId !== runId) throw new DomainError('评测记录不存在。');
    this.active.get(id)?.controller.abort(new Error('用户停止评测。'));
  }
  async close() {
    this.closing = true;
    for (const item of this.active.values()) item.controller.abort(new Error('服务关闭，评测未完成。'));
    await Promise.allSettled([...this.active.values()].map(item => item.done));
    this.store.close();
  }
}
