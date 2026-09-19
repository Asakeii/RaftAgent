import { useRef, useState } from 'react';
import type { Evolution, EvolutionStatus } from '../src/evolution-contracts';
import { useLive } from './useInspectionData';
import './evolution.css';
type Api = (path: string, data?: unknown) => Promise<any>;
const statuses: Record<EvolutionStatus, string> = { generating: '生成候选', ready: '待回归', testing: '回归中', eligible: '可晋升', blocked: '未通过门禁', promoting: '晋升中', promoted: '已晋升', rolling_back: '回滚中', rolled_back: '已回滚', cancelled: '已停止', failed: '实验出错', interrupted: '服务中断' };
export const sampleEvolutionCases = JSON.stringify([{ name: '保留原文件并输出 JSON', prompt: '读取 input.json，将其中的 value 写入 result.json 的 value 字段；保留 input.json。', fixtures: [{ path: 'input.json', text: '{"value":42}' }], checks: [{ path: 'result.json', kind: 'json', expected: '{"value":42}' }, { path: 'input.json', kind: 'text', expected: '{"value":42}' }] }], null, 2);
export function EvolutionPanel({ base, query, api }: { base: string; query: string; api: Api }) {
  const { data, error: loadError, reload } = useLive<{ skills: { id: string; name: string; supported: boolean; reason: string }[]; evolutions: Evolution[] }>(api, base + query);
  const [skill, setSkill] = useState(''), [cases, setCases] = useState(sampleEvolutionCases), [selectedId, setSelectedId] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''); const pending = useRef(false);
  const selected = data?.evolutions.find(e => e.id === selectedId) ?? data?.evolutions[0];
  const active = data?.evolutions.find(e => ['generating', 'testing', 'promoting', 'rolling_back'].includes(e.status));
  const skillId = skill || data?.skills.find(s => s.supported)?.id || '';
  const action = async (name: string, id = selected?.id) => {
    if (!id || pending.current) return; pending.current = true; setBusy(true); setError('');
    try { await api(`${base}/${id}/${name}${query}`, {}); reload(); }
    catch (e) { setError(e instanceof Error ? e.message : '操作失败'); }
    finally { pending.current = false; setBusy(false); }
  };
  return <section className="evolution-panel" aria-label="Skill 自进化">
    <div className="evaluation-heading"><strong>Skill 自进化</strong><small>候选 → 新旧回归 → 晋升 → 回滚</small></div>
    <p className="evaluation-hint">将这次未通过评测用于改进本地 Skill。首期支持无脚本的文本文件能力，回归只允许读取和编辑独立目录中的文件。</p>
    <details open={!data?.evolutions.length}><summary>配置改进实验</summary>
      <form onSubmit={async e => {
        e.preventDefault(); if (pending.current) return; pending.current = true; setBusy(true); setError('');
        try { const parsed = JSON.parse(cases); const value = await api(base + query, { skillId, cases: parsed }) as Evolution; setSelectedId(value.id); reload(); }
        catch (e) { setError(e instanceof Error ? e.message : '实验启动失败'); }
        finally { pending.current = false; setBusy(false); }
      }}>
        <fieldset disabled={busy || !!active}>
          <label>待改进 Skill<select aria-label="待改进 Skill" value={skillId} onChange={e => setSkill(e.target.value)}><option value="">请选择本地 Skill</option>{data?.skills.map(s => <option key={s.id} value={s.id} disabled={!s.supported}>{s.name}{s.supported ? '' : '（不支持）'}</option>)}</select></label>
          {!data?.skills.some(s => s.supported) && <p className="evaluation-hint">暂无受支持的本地 Skill。请先为该 Agent 启用一个无脚本的自建 Skill；内置协作能力不参与本期进化。</p>}
          {data?.skills.filter(s => !s.supported).map(s => <p className="evaluation-hint" key={s.id}>{s.name}：{s.reason}</p>)}
          <label>回归 Case（JSON）<textarea aria-label="回归 Case" spellCheck={false} rows={14} value={cases} onChange={e => setCases(e.target.value)} required maxLength={150000} /></label>
          <p className="evaluation-hint">请把示例替换成真实任务。fixtures 是输入文件；checks 支持 text（全文相等）、json（结构相等）、exists（存在）。每条 Case 至少一个内容断言。预期值只供程序验收，不传给改进模型或执行模型。</p>
          <p className="evaluation-hint">启动后调用模型生成候选，并让新旧版本各执行 2 次；共用 4 美元 SDK 估算预算，最多 10 分钟。通过门禁后仍需点击晋升。</p>
          <button className="primary" disabled={!skillId || !data}>生成候选并回归</button>
        </fieldset>
      </form>
    </details>
    {(error || loadError) && <p role="alert" className="inspection-error">{error || loadError}</p>}
    {active && <div className="evaluation-progress" role="status"><span>{statuses[active.status]} · {active.trials.length}/{active.cases.length * active.repeats * 2} 次试验</span><button disabled={busy || !['generating', 'testing'].includes(active.status)} onClick={() => { setSelectedId(active.id); void action('cancel', active.id); }}>停止实验</button></div>}
    {!!data?.evolutions.length && <label className="evaluation-history">进化记录<select aria-label="选择进化记录" value={selected?.id ?? ''} onChange={e => setSelectedId(e.target.value)}>{data.evolutions.map(e => <option key={e.id} value={e.id}>{new Date(e.createdAt).toLocaleString()} · {statuses[e.status]}</option>)}</select></label>}
    {selected && <div className="evolution-result">
      <div className="evaluation-summary"><strong>{statuses[selected.status]}</strong><span>{selected.skillName} · {selected.baselineVersion.slice(0, 8)} → {selected.candidateVersion?.slice(0, 8) ?? '待生成'}</span><small>SDK 估算 ${selected.costUsd.toFixed(4)}{!selected.costComplete && '（费用可能不完整）'}</small></div>
      <p>{selected.summary}</p>{selected.applicability && <p>适用条件：{selected.applicability}</p>}
      <p className="evaluation-hint">执行模型：{selected.model} · 改进模型：{selected.generatorModel} · {selected.profile} · Case 快照 {selected.caseHash.slice(0, 12)}</p>
      <div className="evaluation-summary">{(['baseline', 'candidate'] as const).map(variant => { const trials = selected.trials.filter(t => t.variant === variant); return <span key={variant}>{variant === 'baseline' ? '基线' : '候选'}：通过 {trials.filter(t => t.passed).length}/{trials.length} · 合计 {(trials.reduce((sum, t) => sum + t.durationMs, 0) / 1000).toFixed(1)} 秒 · ${trials.reduce((sum, t) => sum + t.costUsd, 0).toFixed(4)}</span>; })}</div>
      {selected.error && <p className="inspection-error">{selected.error}</p>}
      <ul>{selected.gate.reasons.map(r => <li key={r}>{r}</li>)}</ul>
      <div className="evaluation-actions">
        {selected.status === 'eligible' && <button className="primary" disabled={busy} onClick={() => void action('promote')}>晋升为正式版本</button>}
        {selected.status === 'promoted' && <button className="secondary" disabled={busy} onClick={() => void action('rollback')}>回滚到基线版本</button>}
      </div>
      <p className="evaluation-hint">晋升影响所有启用此共享 Skill 的 Agent，在后续运行或重新加载时生效。存在活动运行、未发布源码修改或正式版本变化时会拒绝切换。两次重复只能证明本组 Case 的观察结果，不能保证所有任务都改善。</p>
      {!!selected.candidate.length && <details><summary>查看候选修改</summary>{selected.candidate.filter(f => selected.baseline.find(b => b.path === f.path)?.text !== f.text).map(f => <div key={f.path}><strong>{f.path}</strong><div className="evolution-diff"><div><small>基线</small><pre>{selected.baseline.find(b => b.path === f.path)?.text ?? '新增文件'}</pre></div><div><small>候选</small><pre>{f.text}</pre></div></div></div>)}</details>}
      <details><summary>冻结的回归 Case</summary><pre>{JSON.stringify(selected.cases, null, 2)}</pre></details>
      {selected.trials.map((t, i) => <details className="evolution-trial" key={i}><summary>{selected.cases.find(c => c.id === t.caseId)?.name} · {t.variant === 'baseline' ? '基线' : '候选'} 第 {t.repeat} 次 · {t.status === 'error' ? '执行错误' : t.passed ? '通过' : '失败'} · {(t.durationMs / 1000).toFixed(1)} 秒</summary>
        {t.error && <p>{t.error}</p>}{t.checks.map((c, j) => <p key={j}>{c.passed ? '✓' : '×'} {c.path} · {c.kind} · {c.reason}</p>)}
        <details><summary>实际产物</summary>{t.artifacts.map(f => <div key={f.path}><strong>{f.path}</strong><pre>{f.text}</pre></div>)}</details>
        <details><summary>执行轨迹</summary><pre>{t.transcript.join('\n\n')}</pre></details>
      </details>)}
    </div>}
  </section>;
}
