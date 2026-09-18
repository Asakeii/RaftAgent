import { useState } from 'react';
import type { TraceEvent } from '../src/inspection-contracts';
import './trace-explorer.css';

function category(event: TraceEvent) {
  if (event.level === 'error') return ['failure', '!', '异常'];
  if (event.kind.startsWith('permission.')) return ['permission', '◇', '授权'];
  if (event.kind.startsWith('tool.')) return ['tool', '⌘', '工具'];
  if (/^(model|assistant)\./.test(event.kind)) return ['model', '✦', '模型'];
  return ['system', '○', '运行'];
}
const duration = (ms: number) => ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
const time = (at: string) => new Date(at).toLocaleTimeString('zh-CN', { hour12: false });
export function TraceExplorer({ events, startedAt }: { events: TraceEvent[]; startedAt?: string }) {
  const [selection, setSelection] = useState<number>();
  const [query, setQuery] = useState('');
  const [view, setView] = useState<'summary' | 'raw'>('summary');
  const visible = events.filter(e => JSON.stringify(e).toLowerCase().includes(query.toLowerCase()));
  const selected = visible.find(e => e.seq === selection) ?? visible[0];
  const start = Date.parse(startedAt ?? events[0]?.at ?? '') || 0;
  const end = Math.max(start + 1, ...events.map(e => Date.parse(e.at)).filter(Number.isFinite));
  const select = (event: TraceEvent) => { setSelection(event.seq); };
  return <section className="trace-explorer" aria-label="事件轨迹浏览器">
    <div className="explorer-toolbar"><span><b>{visible.length}</b> / {events.length} 事件</span><span>{events.filter(e => e.kind === 'tool.start').length} 工具调用</span><label><span className="sr-only">搜索轨迹事件</span><input aria-label="搜索轨迹事件" placeholder="搜索事件、工具或内容…" value={query} onChange={e => setQuery(e.target.value)} /></label></div>
    <div className="explorer-timeline" aria-label="事件时间轴">{[['system', '运行'], ['model', '模型'], ['tool', '工具'], ['permission', '授权'], ['failure', '异常']].map(([kind, label]) => <div className="explorer-lane" key={kind}><span>{label}</span><div>{visible.filter(e => category(e)[0] === kind).map(e => {
      const at = Date.parse(e.at); const offset = Math.max(0, at - start - (e.durationMs ?? 0));
      return <button key={e.seq} className={`explorer-mark ${kind}`} aria-label={`定位事件 ${e.seq}：${e.summary}`} aria-pressed={selected?.seq === e.seq} title={`${time(e.at)} · ${e.summary}${e.durationMs === undefined ? '' : ` · ${duration(e.durationMs)}`}`} style={{ left: `${Math.min(99, offset / (end - start) * 100)}%`, width: e.durationMs ? `${Math.min(100, e.durationMs / (end - start) * 100)}%` : '4px' }} onClick={() => select(e)} />;
    })}</div></div>)}<div className="explorer-scale"><span>+0 s</span><span>事件时刻 / 已记录耗时</span><span>+{duration(end - start)}</span></div></div>
    <div className="explorer-split"><div className="explorer-list" role="group" aria-label="轨迹事件列表">{visible.map(e => { const [kind, icon] = category(e); return <button key={e.seq} className={`event-node explorer-row ${kind}`} aria-pressed={selected?.seq === e.seq} onClick={() => select(e)}><span className="explorer-seq">{e.seq}</span><span className="explorer-icon">{icon}</span><time>{time(e.at)}</time><span className="explorer-summary" title={e.summary}>{e.summary}</span><small>{e.durationMs === undefined ? e.kind : duration(e.durationMs)}</small></button>; })}{!visible.length && <p className="explorer-empty">没有匹配的已加载事件</p>}</div>
    <aside className="explorer-detail" aria-label="选中事件详情">{selected ? <><header><span className={`explorer-type ${category(selected)[0]}`}>{category(selected)[2]}</span><code>事件 #{selected.seq}</code></header><nav aria-label="事件详情视图"><button aria-pressed={view === 'summary'} onClick={() => setView('summary')}>摘要</button><button aria-pressed={view === 'raw'} onClick={() => setView('raw')}>Raw</button></nav>{view === 'raw' ? <pre>{JSON.stringify(selected, null, 2)}</pre> : <div className="explorer-detail-body"><dl><dt>事件类型</dt><dd>{selected.kind}</dd><dt>级别</dt><dd>{selected.level}</dd><dt>发生时间</dt><dd>{time(selected.at)}</dd><dt>耗时</dt><dd>{selected.durationMs === undefined ? '未记录' : duration(selected.durationMs)}</dd>{selected.toolId && <><dt>工具调用</dt><dd>{selected.toolId}</dd></>}</dl><h4>事件摘要</h4><p>{selected.summary}</p>{selected.detail !== undefined && <><h4>事件内容</h4><pre>{typeof selected.detail === 'string' ? selected.detail : JSON.stringify(selected.detail, null, 2)}</pre></>}</div>}</> : <p className="explorer-empty">选择事件查看详情</p>}</aside></div>
  </section>;
}
