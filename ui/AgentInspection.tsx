import { useEffect, useRef, useState } from 'react';
import type { Agent } from '../src/contracts';
import type { TraceList, TraceDetail, TraceEvent } from '../src/inspection-contracts';
export { AgentHistory } from './AgentHistory';
import './inspection.css';
import { EvaluationPanel } from './EvaluationPanel';
import { TraceExplorer } from './TraceExplorer';
import { useLive } from './useInspectionData';

type Api = (path: string, data?: unknown) => Promise<any>;
const time = (value?: string) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '时间未记录';
const duration = (value?: number) => value === undefined ? '—' : value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} s`;
const short = (value: string) => value.slice(0, 8);
const states: Record<string, string> = { running: '执行中', done: '已结束', error: '失败', stopped: '已停止', unknown: '待核验', idle: '待命' };
function ErrorNotice({ text }: { text: string }) { return text ? <p className="inspection-error" role="alert">{text}</p> : null; }
export function AgentTraces({ agent, api, selectedRun, selectRun, onAgent, conversationId = agent.id }: { agent: Agent; conversationId?: string; api: Api; selectedRun: string; selectRun: (id: string) => void; onAgent: (id: string, runId: string, channel?: string) => void }) {
  const [before, setBefore] = useState('');
  const { data, error, reload } = useLive<TraceList>(api, `agents/${agent.id}/traces?${new URLSearchParams({ conversationId, ...(before ? { before } : {}) })}`);
  const active = data?.runs.find(r => r.status === 'running');
  const reason = data?.agentStatus === 'running' ? active?.phase || 'Agent 正在执行，返回最新列表查看当前运行。' : !data?.ready ? '未配置 API Key，消息等待执行。' : data.agentStatus === 'stopped' ? 'Agent 已停止；发送新消息即可重新唤起。' : data.agentStatus === 'error' ? '上轮执行失败；处理问题后发送新消息重试。' : active ? active.phase : data?.pending ? '等待调度，有空闲执行名额后开始。' : '当前没有待执行输入。';
  return <section className="inspection" aria-label="执行日志">
    <div className="inspection-head"><div><span className="eyebrow">EXECUTION JOURNAL</span><h3>执行追踪</h3><p>记录真实事件、工具往返与执行结果。每次输入对应一个独立 Run。</p></div><button className="secondary" onClick={reload}>刷新日志</button></div>
    <ErrorNotice text={error || data?.warning || ''} />
    {data && <div className="run-state" role="status"><span className={`status-dot ${data.agentStatus}`} /><strong>{states[data.agentStatus]}</strong><span>{reason}</span><small>{data.pending} 条排队</small></div>}
    {selectedRun ? <TraceRecord key={selectedRun} api={api} agentId={agent.id} conversationId={conversationId} runId={selectedRun} back={() => selectRun('')} onAgent={onAgent} /> : <>
      <div className="inspection-pager"><span>最近执行 · 点击查看事件详情</span><div><button disabled={!data?.nextBefore} onClick={() => setBefore(data!.nextBefore!)}>更早执行 ↑</button><button disabled={!before} onClick={() => setBefore('')}>回到最新 ↓</button></div></div>
      {data?.runs.map(run => <button className="run-card" key={run.id} onClick={() => selectRun(run.id)}><div><span className={`run-badge ${run.status}`}>{states[run.status]}</span><time>{time(run.startedAt)}</time><code>{short(run.id)}</code></div><strong>{run.prompt || '无文本输入'}</strong><footer><span>{run.model}</span><span>{run.phase}</span><span>{duration(run.durationMs)}</span><span>查看详情 ↗</span></footer></button>)}
      {data && !data.runs.length && <div className="inspection-empty"><span>◎</span><h4>还没有采集的执行日志</h4><p>新运行会自动记录；已有聊天可在“会话详情”中查看。</p></div>}
      {!!data?.legacyRuns && <p className="inspection-footnote">另有 {data.legacyRuns} 次旧运行未采集详细日志，不补造历史耗时与事件。</p>}
    </>}
  </section>;
}
function TraceRecord({ api, agentId, conversationId, runId, back, onAgent }: { api: Api; agentId: string; conversationId: string; runId: string; back: () => void; onAgent: (id: string, runId: string, channel?: string) => void }) {
  const [data, setData] = useState<TraceDetail>(); const [events, setEvents] = useState<TraceEvent[]>([]); const [error, setError] = useState(''); const [query, setQuery] = useState(''); const [level, setLevel] = useState('all');
  const cursor = useRef(0); const busy = useRef(false); const alive = useRef(true);
  const load = async () => {
    if (busy.current) return; busy.current = true;
    try { const next = await api(`agents/${agentId}/traces/${runId}?after=${cursor.current}&conversationId=${encodeURIComponent(conversationId)}`) as TraceDetail;
      if (alive.current) { setData(next); setError(''); setEvents(old => [...new Map([...old, ...next.events].map(e => [e.seq, e])).values()]); cursor.current = next.events.at(-1)?.seq ?? cursor.current; }
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : '读取失败'); }
    finally { busy.current = false; }
  };
  useEffect(() => { alive.current = true; void load(); const timer = setInterval(() => void load(), 2000); return () => { alive.current = false; clearInterval(timer); }; }, [agentId, conversationId, runId]);
  const run = data?.run; const visible = events.filter(e => (level === 'all' || e.level === level) && (!query || JSON.stringify(e).toLowerCase().includes(query.toLowerCase())));
  return <div className="trace-record"><button className="back-link" onClick={back}>← 返回执行列表</button><ErrorNotice text={error || data?.warning || ''} />
    {run && <><div className="trace-title"><span className={`run-badge ${run.status}`}>{states[run.status]}</span><code>{run.id}</code></div><p className="trace-prompt">{run.prompt}</p>
      <div className="trace-metrics"><div><small>执行总耗时</small><strong>{duration(run.durationMs)}</strong></div><div><small>SDK API 累计耗时</small><strong>{duration(run.apiDurationMs)}</strong></div><div><small>SDK turns</small><strong>{run.turns ?? '—'}</strong></div><div><small>模型成本（元）</small><strong>{run.costCny === undefined ? (run.pricing ? '用量不完整' : '未配置价格') : `¥${run.costCny.toFixed(6)}`}</strong></div></div>
      <details className="trace-context"><summary>运行配置与用量</summary><dl><dt>模型</dt><dd>{run.model}</dd><dt>API 地址</dt><dd>{run.baseUrl}</dd><dt>会话</dt><dd>{run.sessionId || '未建立'}</dd><dt>开始</dt><dd>{time(run.startedAt)}</dd><dt>结束</dt><dd>{run.endedAt ? time(run.endedAt) : '未记录'}</dd><dt>来源</dt><dd>{run.kind} · {run.channel}</dd><dt>Trace</dt><dd>{run.traceId}</dd></dl><pre>{JSON.stringify(run.usage ?? {}, null, 2)}</pre>{run.pricing ? <p>本轮单价（元/百万 tokens）：输入 {run.pricing.input} · 输出 {run.pricing.output} · 缓存命中 {run.pricing.cacheHitEnabled ? run.pricing.cacheHit : '关闭，按输入价'}。缓存写入按输入价计费；按 SDK 用量核算，仅包含 token 费用。</p> : <p>本次运行未记录人民币单价，可在设置中配置后用于新运行。</p>}<p>SDK 原始美元估算：{run.estimatedCostUsd === undefined ? '未记录' : `$${run.estimatedCostUsd.toFixed(6)}`}。最终费用以服务商账单为准。</p></details>
      {!!data?.skillUsage?.length && <details className="trace-context"><summary>Skill 使用证据（{data.skillUsage.length}）</summary>
        {data.skillUsage.map(s => <p key={`${s.skillId}:${s.skillVersion}`}><strong>{s.skillName}</strong> · {s.skillVersion.slice(0, 10)} · {s.state === 'loaded_only' ? '仅观察到加载' : s.state === 'execution_observed' ? '已观察到执行' : '结果未知'}<br />加载 {s.loaded} / 失败 {s.loadFailed} · 服务返回 {s.serviceReturned} / 失败 {s.serviceFailed} / 重放 {s.replayed} · 进程成功 {s.processSucceeded} / 失败 {s.processFailed} · 未收尾 {s.incomplete}</p>)}
        <p>加载说明不代表使用能力；服务返回和进程成功不代表任务成功。绕过受控入口的执行可能缺少证据。</p>
      </details>}
      <EvaluationPanel key={run.id} run={run} conversationId={conversationId} api={api} />
      {run.error && <ErrorNotice text={run.error} />}
      {!!data?.related.filter(r => r.id !== run.id).length && <div className="trace-related"><span>关联执行</span>{data?.related.filter(r => r.id !== run.id).map(r => <button key={r.id} onClick={() => onAgent(r.agentId, r.id, r.channel)}>{short(r.agentId)} / {short(r.id)} · {states[r.status]} ↗</button>)}</div>}
    </>}
    <div className="inspection-toolbar"><label>级别<select aria-label="筛选日志级别" value={level} onChange={e => setLevel(e.target.value)}><option value="all">全部级别</option><option value="warn">警告</option><option value="error">错误</option><option value="info">信息</option></select></label><input aria-label="搜索已加载日志" placeholder="搜索已加载的事件…" value={query} onChange={e => setQuery(e.target.value)} /></div>
    <TraceExplorer events={visible} startedAt={run?.startedAt} />
    {!visible.length && <p className="inspection-footnote">{data ? '没有匹配的已加载事件。' : '正在读取执行日志…'}</p>}
    {data?.nextAfter !== null && data && <button className="secondary" onClick={() => void load()}>加载后续日志</button>}
    <p className="inspection-footnote">已加载 {events.length} 条事件 · 每 2 秒刷新。工具耗时包含授权等待。日志记录 SDK 可观察事件，不等于每次 HTTP 请求的完整报文。</p>
  </div>;
}
