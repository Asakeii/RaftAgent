import { useEffect, useRef, useState } from 'react';
import { DEFAULT_EVALUATION_RULES, type Evaluation, type EvaluationProfile, type EvaluationRule } from '../src/evaluation-contracts';
import type { TraceRun } from '../src/inspection-contracts';
import { useLive } from './useInspectionData';
import './evaluation.css';

type Api = (path: string, data?: unknown) => Promise<any>;
const verdicts = { pass: '通过', fail: '失败', unknown: '未知', inconclusive: '待判定' };
const statuses = { running: '评测中', completed: '已完成', failed: '评测出错', cancelled: '已停止', interrupted: '服务中断' };
export function EvaluationPanel({ run, conversationId, api }: { run: TraceRun; conversationId: string; api: Api }) {
  const base = `agents/${run.agentId}/traces/${run.id}/evaluations`;
  const scopeQuery = `?conversationId=${encodeURIComponent(conversationId)}`;
  const { data, error: loadError, reload } = useLive<{ profile: EvaluationProfile; evaluations: Evaluation[] }>(api, base + scopeQuery);
  const [objective, setObjective] = useState(run.prompt);
  const [rules, setRules] = useState<EvaluationRule[]>(DEFAULT_EVALUATION_RULES.map(r => ({ ...r })));
  const [scope, setScope] = useState<'run' | 'trace'>('run');
  const [selectedId, setSelectedId] = useState(''); const [evidenceId, setEvidenceId] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const submitted = useRef(false);
  const active = data?.evaluations.find(e => e.status === 'running');
  const selected = data?.evaluations.find(e => e.id === selectedId) ?? data?.evaluations[0];
  const evidence = selected?.evidence.find(e => e.id === evidenceId);
  useEffect(() => { setEvidenceId(''); }, [selected?.id]);
  const loadCase = () => { if (selected) { setObjective(selected.objective); setScope(selected.scope); setRules(selected.states.map(({ id, text, required }) => ({ id, text, required }))); } };
  return <section className="evaluation-panel" aria-label="轨迹评测">
    <div className="evaluation-heading"><div><strong>轨迹裁判</strong><span>内置 · v{data?.profile.version ?? '1.0.0'}</span></div><small>模型：{data?.profile.model ?? '读取中…'}</small></div>
    <p className="evaluation-hint">分窗口检查轨迹并更新规则状态。仅评日志证据，不能代替真实文件和业务结果验收。</p>
    <details className="evaluation-case" open={!data?.evaluations.length}>
      <summary>Case 目标与验收规则</summary>
      <form onSubmit={async e => {
        e.preventDefault(); if (submitted.current) return; submitted.current = true; setBusy(true); setError('');
        try { const value = await api(base + scopeQuery, { objective, rules, scope }) as Evaluation; setSelectedId(value.id); reload(); }
        catch (err) { setError(err instanceof Error ? err.message : '启动失败'); }
        finally { setBusy(false); submitted.current = false; }
      }}>
        <fieldset disabled={busy || !!active}>
          <label className="evaluation-label">任务目标<textarea aria-label="评测任务目标" value={objective} required maxLength={8000} rows={3} onChange={e => setObjective(e.target.value)} /></label>
          <div className="evaluation-rules-label"><strong>验收规则</strong><small>必须项全部通过，整体才通过；未知保持待判定。</small></div>
          {rules.map((rule, i) => <div className="evaluation-rule-edit" key={i}>
            <span>R{i + 1}</span><textarea aria-label={`规则 ${i + 1}`} rows={2} required maxLength={1000} value={rule.text} onChange={e => setRules(old => old.map((r, j) => j === i ? { ...r, text: e.target.value } : r))} />
            <label><input type="checkbox" checked={rule.required} onChange={e => setRules(old => old.map((r, j) => j === i ? { ...r, required: e.target.checked } : r))} />必须</label>
            <button type="button" disabled={rules.length <= 1} aria-label={`删除规则 ${i + 1}`} onClick={() => setRules(old => old.filter((_, j) => j !== i))}>×</button>
          </div>)}
          <div className="evaluation-actions"><button type="button" className="secondary" disabled={rules.length >= 20} onClick={() => setRules(old => [...old, { id: `r${old.length + 1}`, text: '', required: true }])}>＋ 添加规则</button>{selected && <button type="button" className="secondary" onClick={loadCase}>载入所选评测的 Case</button>}</div>
          <label className="evaluation-scope"><input type="checkbox" checked={scope === 'trace'} onChange={e => setScope(e.target.checked ? 'trace' : 'run')} />包含同一 Trace 的关联执行（可能跨会话；不代表完整业务 Trial）</label>
          <p className="evaluation-hint">每窗口最多 10 条证据，重叠 2 条；点击后调用模型并产生费用。每次最多 10 分钟、2 美元 SDK 估算预算。</p>
          <button className="primary" type="submit" disabled={!data?.profile.ready || run.status === 'running' || !rules.some(r => r.required)}>{busy ? '正在启动…' : '开始评测'}</button>
          {!data?.profile.ready && <span className="evaluation-hint"> 请先在设置中配置模型。</span>}{run.status === 'running' && <span className="evaluation-hint"> 请等待运行结束。</span>}
        </fieldset>
      </form>
    </details>
    {(error || loadError) && <p role="alert" className="inspection-error">{error || loadError}</p>}
    {active && <div className="evaluation-progress" role="status"><span>评测中 · {active.windows.length}/{active.totalWindows} 窗口</span><button disabled={busy} onClick={async () => { setBusy(true); setError(''); try { await api(`${base}/${active.id}/cancel${scopeQuery}`, {}); reload(); } catch (e) { setError(e instanceof Error ? e.message : '停止失败'); } finally { setBusy(false); } }}>停止评测</button></div>}
    {!!data?.evaluations.length && <label className="evaluation-history">评测记录<select aria-label="选择评测记录" value={selected?.id ?? ''} onChange={e => setSelectedId(e.target.value)}>{data.evaluations.map(e => <option key={e.id} value={e.id}>{new Date(e.createdAt).toLocaleString('zh-CN', { hour12: false })} · {statuses[e.status]} · {verdicts[e.verdict]}</option>)}</select></label>}
    {selected && <div className="evaluation-result">
      <div className="evaluation-summary"><strong className={`evaluation-verdict ${selected.verdict}`}>{verdicts[selected.verdict]}</strong><span>{statuses[selected.status]} · {selected.windows.length}/{selected.totalWindows} 窗口 · {selected.sourceRunIds.length} 个 Run</span><small>裁判 SDK 估算 ${selected.costUsd.toFixed(4)}{!selected.costComplete && '（费用不完整）'}</small></div>
      <p className="evaluation-hint">本次模型 {selected.profile.model} · 裁判 v{selected.profile.version} · 通过 {selected.states.filter(s => s.verdict === 'pass').length}/{selected.states.length} 项（不等于整体通过）</p>
      {selected.error && <p role="alert" className="inspection-error">{selected.error}</p>}
      <ul className="evaluation-warnings">{selected.warnings.map(w => <li key={w}>{w}</li>)}</ul>
      {selected.states.map(rule => <div key={rule.id} className="evaluation-rule-result"><div><strong>{rule.id.toUpperCase()} · {rule.text}</strong><span className={`evaluation-verdict ${rule.verdict}`}>{verdicts[rule.verdict]}{rule.required ? ' · 必须' : ' · 参考'}</span></div><p>{rule.reason}</p><div className="evaluation-evidence-links">{rule.evidenceRefs.map(ref => <button key={ref} onClick={() => setEvidenceId(ref)}>{ref}</button>)}</div></div>)}
      {evidence && <div className="evaluation-evidence"><strong>{evidence.id} · {evidence.kind}</strong><p className="evaluation-hint">{evidence.at} · Run {evidence.runId}</p><pre>{evidence.text}</pre></div>}
      <details><summary>窗口状态变化与证据快照</summary><p className="evaluation-hint">快照 SHA-256：{selected.evidenceHash}</p>{selected.windows.map(w => <details className="evaluation-window" key={w.index}><summary>窗口 {w.index} · {w.evidenceIds.length} 条证据 · {(w.durationMs / 1000).toFixed(1)} 秒</summary>{w.states.map(r => <p key={r.id}><strong>{r.id} · {verdicts[r.verdict]}</strong> {r.reason}</p>)}<div className="evaluation-evidence-links">{w.evidenceIds.map(id => <button key={id} onClick={() => setEvidenceId(id)}>{id}</button>)}</div></details>)}</details>
    </div>}
  </section>;
}
