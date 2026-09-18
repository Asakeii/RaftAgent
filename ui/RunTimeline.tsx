import React, { useEffect, useState } from 'react';
import type { AppState, Run } from '../src/contracts';
import type { TraceDetail, TraceEvent } from '../src/inspection-contracts';
import './timeline.css';
import { TraceExplorer } from './TraceExplorer';
const stamp = (value: string) => new Date(value).toLocaleTimeString('zh-CN', { hour12: false });
const duration = (ms: number) => ms < 1000 ? `${Math.round(ms)} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} 秒` : `${Math.floor(ms / 60000)} 分 ${Math.floor(ms / 1000) % 60} 秒`;
const states: Record<string, string> = { running: '运行中', done: '已结束', error: '异常 / 已停止', stopped: '已停止', unknown: '待核验' };
function EventTimeline({ run, api, openLog }: { run: Run; api: (path: string) => Promise<unknown>; openLog: () => void }) {
  const [data, setData] = useState<TraceDetail>();
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let live = true, busy = false, cursor = 0;
    setData(undefined); setEvents([]); setError('');
    const load = async () => {
      if (busy) return; busy = true;
      try {
        const next = await api(`agents/${run.agentId}/traces/${run.id}?after=${cursor}&conversationId=${encodeURIComponent(run.channel ?? run.agentId)}`) as TraceDetail;
        if (!live) return;
        setData(next); setError('');
        setEvents(old => [...new Map([...old, ...next.events].map(e => [e.seq, e])).values()].sort((a, b) => a.seq - b.seq));
        cursor = next.events.at(-1)?.seq ?? cursor;
      } catch (e) { if (live) setError(e instanceof Error ? e.message : '无法读取时间线'); }
      finally { busy = false; }
    };
    void load(); const timer = setInterval(() => void load(), 2000);
    return () => { live = false; clearInterval(timer); };
  }, [run.id, run.agentId, run.channel, api, reload]);
  return <div className="run-event-panel">
    <div className="run-event-heading"><div><strong>{data?.run.phase ?? '读取执行过程'}</strong><p>{data?.run.durationMs !== undefined ? `总耗时 ${duration(data.run.durationMs)} · ` : ''}{data ? states[data.run.status] : '等待日志'} · 按发生顺序</p></div><button onClick={openLog}>完整日志 ↗</button></div>
    {error && <div className="timeline-error" role="alert">{error}<button onClick={() => setReload(x => x + 1)}>重新读取</button><p>旧运行可能未采集日志，不补造历史阶段或耗时。</p></div>}
    {data?.warning && <p className="timeline-error">{data.warning}</p>}
    {data?.run.prompt && <p className="timeline-prompt">{data.run.prompt.slice(0, 400)}</p>}
    <TraceExplorer events={events} startedAt={data?.run.startedAt ?? run.at} />
    {data && !events.length && <p className="monitor-empty">当前没有已采集事件。</p>}
    {data?.run.status === 'running' && <div className="timeline-live"><i />{data.run.phase} · 新事件每 2 秒更新</div>}
    {data?.nextAfter != null && <p className="timeline-note">正在分批读取后续事件，每批最多 200 条。</p>}
    <p className="timeline-note">时间来自已采集日志；工具耗时包含授权等待。</p>
  </div>;
}
export function RunTimeline({ runs, state, api, jump }: { runs: Run[]; state: AppState; api: (path: string) => Promise<unknown>; jump: (agent: string, run: string, channel?: string) => void }) {
  const [expanded, setExpanded] = useState('');
  const [filter, setFilter] = useState('all');
  const [limit, setLimit] = useState(20);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const filtered = [...runs].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).filter(r => filter === 'all' || r.status === filter);
  return <section className="run-timeline-section" aria-label="运行时间线"><header><div><span className="monitor-kicker">执行轨迹</span><h2>运行时间线 <small>{filtered.length} 次</small></h2><p>最新运行在前，展开查看完整执行轨迹。</p></div><select aria-label="筛选运行状态" value={filter} onChange={e => { setFilter(e.target.value); setLimit(20); }}><option value="all">全部状态</option><option value="running">运行中</option><option value="done">已结束</option><option value="error">异常 / 已停止</option><option value="unknown">待核验</option></select></header>
    <div className="timeline-legend"><span><i className="model" />模型响应</span><span><i className="tool" />工具调用</span><span><i className="permission" />授权等待</span><span><i className="failure" />异常</span></div>
    {!filtered.length && <p className="monitor-empty">当前没有匹配的运行记录。发送任务后，执行轨迹会出现在这里。</p>}
    <ol className="run-timeline">{filtered.slice(0, limit).map((r, i) => { const date = new Date(r.at).toLocaleDateString('zh-CN'); const previousDate = i ? new Date(filtered[i - 1]!.at).toLocaleDateString('zh-CN') : ''; const title = `${state.rooms.some(x => x.id === r.channel) ? '群聊协作' : '私聊任务'} · ${r.id.slice(0, 8)}`; return <li className={`run-node ${r.status}`} key={r.id}>{date !== previousDate && <div className="timeline-date">{date}</div>}<button className="run-summary" aria-expanded={expanded === r.id} onClick={() => setExpanded(expanded === r.id ? '' : r.id)}><time>{stamp(r.at)}</time><i className="run-marker" /><div className="run-summary-main"><div><strong>{state.agents.find(a => a.id === r.agentId)?.name ?? '已删除的 Agent'}</strong><span>{state.rooms.find(x => x.id === r.channel)?.name ?? '私聊'}</span><b className={`timeline-badge ${r.status}`}>{states[r.status]}</b></div><p>{title.slice(0, 160)}</p></div><span className="run-expand">{r.status === 'running' ? `已运行 ${duration(Math.max(0, now - Date.parse(r.at)))}` : '查看过程'} {expanded === r.id ? '−' : '+'}</span></button>{expanded === r.id && <EventTimeline key={r.id} run={r} api={api} openLog={() => jump(r.agentId, r.id, r.channel)} />}</li>; })}</ol>
    {filtered.length > limit && <button className="timeline-more" onClick={() => setLimit(n => n + 20)}>加载更早的运行</button>}
  </section>;
}
