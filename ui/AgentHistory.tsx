import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { Agent } from '../src/contracts';
import type { HistoryPage, HistoryMessage, HistoryBlock } from '../src/inspection-contracts';
import { MessageContent } from './MessageContent';
import './history.css';
import { useLive } from './useInspectionData';

type Api = (path: string) => Promise<any>;
const labels = { input: '输入', assistant: '模型', tool: '工具结果', system: '系统' };
const compact = (text: string) => text.replace(/\s+/g, ' ').trim();
const short = (text: string) => text.slice(0, 8);
const failed = (message: HistoryMessage) => message.blocks.some(block => block.error);
const fullTime = (at?: string) => at ? new Date(at).toLocaleString('zh-CN', { hour12: false }) : '时间未记录';
const clockTime = (at?: string) => at ? new Date(at).toLocaleTimeString('zh-CN', { hour12: false }) : '—';
function toolPreview(block: HistoryBlock) {
  if (block.kind === 'tool_use') {
    try {
      const input = JSON.parse(block.text);
      for (const key of ['command', 'file_path', 'path', 'query', 'pattern', 'url']) {
        if (typeof input?.[key] === 'string') return compact(input[key]).slice(0, 180);
      }
    } catch { /* Truncated inputs remain readable as text. */ }
  }
  return compact(block.text).slice(0, 180);
}
function Highlight({ text, query }: { text: string; query: string }) {
  const index = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1;
  return index < 0 ? text : <>{text.slice(0, index)}<mark>{text.slice(index, index + query.length)}</mark>{text.slice(index + query.length)}</>;
}

export function AgentHistory({ agent, api, onRun }: { agent: Agent; api: Api; onRun: (id: string) => void }) {
  const [session, setSession] = useState(''); const [before, setBefore] = useState('');
  const [query, setQuery] = useState(''); const [filter, setFilter] = useState('all');
  const { data, error, loading, reload } = useLive<HistoryPage>(api, `agents/${agent.id}/history?${new URLSearchParams({ ...(session ? { sessionId: session } : {}), ...(before ? { before } : {}) })}`);
  const [newestFirst, setNewestFirst] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState(''); const [copyNotice, setCopyNotice] = useState('');
  const records = useRef(new Map<string, HTMLElement>());
  const scope = `${agent.id}/${session}/${before}`;
  useEffect(() => { setExpanded(new Set()); setCopyNotice(''); setTarget(''); }, [scope]);
  useEffect(() => {
    if (!target) return;
    const row = records.current.get(target);
    row?.scrollIntoView({ block: 'center' });
    row?.querySelector<HTMLButtonElement>('.history-row-toggle')?.focus({ preventScroll: true });
    setTarget('');
  }, [target]);
  const all = data?.messages ?? [];
  const messages = all.filter(m => (filter === 'all' || (filter === 'failed' ? failed(m) : filter === 'tool' ? m.blocks.some(b => b.kind === 'tool_use' || b.kind === 'tool_result') : m.role === filter)) && (!query || JSON.stringify(m).toLowerCase().includes(query.toLowerCase())));
  if (newestFirst) messages.sort((a, b) => b.turn - a.turn);
  const failureCount = all.filter(failed).length;
  const toggle = (id: string) => setExpanded(old => { const next = new Set(old); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const jump = (id: string) => { setFilter('all'); setQuery(''); setExpanded(old => new Set([...old, id])); setTarget(id); };
  const toolIndex = useMemo(() => {
    const index = new Map<string, { message: HistoryMessage; block: HistoryBlock }[]>();
    for (const message of data?.messages ?? []) for (const block of message.blocks) {
      if (!block.toolId || !['tool_use', 'tool_result'].includes(block.kind)) continue;
      const key = `${block.kind}:${block.toolId}`;
      const entries = index.get(key) ?? []; entries.push({ message, block }); index.set(key, entries);
    }
    return index;
  }, [data]);
  const related = (block: HistoryBlock) => {
    if (!block.toolId || !['tool_use', 'tool_result'].includes(block.kind)) return undefined;
    const matches = toolIndex.get(`${block.kind === 'tool_use' ? 'tool_result' : 'tool_use'}:${block.toolId}`) ?? [];
    // Never guess a relationship when the counterpart is outside this page or ambiguous.
    return matches.length === 1 ? matches[0] : undefined;
  };
  const copy = async (m: HistoryMessage, json: boolean) => {
    try { await navigator.clipboard.writeText(json ? JSON.stringify(m, null, 2) : m.id); setCopyNotice(json ? '已复制脱敏记录 JSON' : '已复制消息 ID'); }
    catch { setCopyNotice('复制失败，可从下方记录 JSON 中手动复制。'); }
  };
  return <section className="inspection history-dense" aria-label="会话详情">
    <div className="history-controls">
      <div className="history-title"><h3>会话记录</h3><button aria-label="切换输入段排序" title="按输入段排序，段内保持消息原始顺序" onClick={() => setNewestFirst(!newestFirst)}>{newestFirst ? "最新输入在前 ↓" : "最早输入在前 ↑"}</button><button disabled={loading} onClick={reload}>{loading ? '读取中…' : '刷新记录'}</button></div>
      <div className="history-filters">
        <select aria-label="选择历史会话" title={data?.sessionId || '选择历史会话'} value={session || data?.sessionId || ''} onChange={e => { setSession(e.target.value); setBefore(''); }}>
          {!data?.sessions.length && <option value="">尚无 SDK 会话</option>}{data?.sessions.map(id => <option value={id} key={id}>{short(id)}{id === agent.sessionId ? ' · 当前' : ''}</option>)}
        </select>
        <select aria-label="筛选会话内容" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">全部记录</option><option value="input">输入与上下文</option><option value="assistant">模型输出</option><option value="tool">工具调用与结果</option><option value="failed">仅看失败</option><option value="system">系统记录</option></select>
        <input aria-label="搜索本页会话" placeholder="搜索本页正文、工具、ID…" value={query} onChange={e => setQuery(e.target.value)} />
      </div>
      <div className="history-counts"><span>{data ? `共 ${data.total} · 本页 ${all.length} · 显示 ${messages.length}` : '读取 SDK 会话…'}</span><button className={failureCount ? 'has-failure' : ''} aria-pressed={filter === 'failed'} onClick={() => setFilter(filter === 'failed' ? 'all' : 'failed')}>失败 {failureCount}</button></div>
      <div className="history-navigation"><div><button disabled={!data?.nextBefore} onClick={() => setBefore(data!.nextBefore!)}>更早记录 ↑</button><button disabled={!before} onClick={() => setBefore('')}>回到最新 ↓</button></div><div><button disabled={!messages.length} onClick={() => setExpanded(old => new Set([...old, ...messages.map(m => m.id)]))}>展开本页</button><button disabled={!expanded.size} onClick={() => setExpanded(new Set())}>全部收起</button></div></div>
    </div>
    {error && <p className="inspection-error" role="alert">{error}</p>}
    <div className="history-copy-notice" role="status">{copyNotice}</div>
    {data && !messages.length && <div className="inspection-empty"><h4>{data.total ? '本页没有匹配的记录' : '尚无可读取的 SDK 记录'}</h4><p>{data.total ? '调整筛选条件或查看其他页。' : '消息尚未执行，或本地会话文件已不可用。'}</p></div>}
    {messages.map((m, i) => {
      const open = expanded.has(m.id);
      const taggedBlocks = m.blocks.filter(b => b.kind !== 'text');
      const preview = compact(m.blocks.find(b => b.error)?.text || m.blocks.find(b => b.kind === 'text')?.text || m.blocks.map(toolPreview).join(' · ')).slice(0, 240);
      return <Fragment key={m.id}>
        {(i === 0 || messages[i - 1]?.turn !== m.turn) && <div className="history-turn"><span>输入段 {m.turn || '—'}</span>{m.runId && <button onClick={() => onRun(m.runId!)}>查看本轮执行 ↗</button>}</div>}
        <article className={`history-record role-${m.role} ${failed(m) ? 'history-failed' : ''}`} data-message-id={m.id} ref={node => { if (node) records.current.set(m.id, node); else records.current.delete(m.id); }}>
          <button className="history-row-toggle" aria-expanded={open} aria-controls={`history-body-${m.id}`} onClick={() => toggle(m.id)}>
            <span className="history-row-meta"><span className="history-chevron" aria-hidden="true">{open ? '⌄' : '›'}</span><strong>{labels[m.role]}</strong>{failed(m) && <b className="history-error-badge">失败</b>}<code title={m.id}>{short(m.id)}</code><time title={fullTime(m.at)}>{clockTime(m.at)}</time></span>
            {!open && <span className="history-preview"><Highlight text={preview || '无文本内容'} query={query} /></span>}
            <span className="history-block-tags">{taggedBlocks.slice(0, 4).map((b, n) => <span key={n} className={b.error ? 'failed' : ''}>{b.kind === 'tool_use' ? `↗ ${b.name}` : b.kind === 'tool_result' ? `↙ ${related(b)?.block.name || '工具返回'}` : b.kind === 'thinking' ? '思考' : b.kind}</span>)}{taggedBlocks.length > 4 && <span>另 {taggedBlocks.length - 4} 块</span>}</span>
          </button>
          <div id={`history-body-${m.id}`} hidden={!open} className="history-record-body">
            {open && <>
              <div className="history-record-info">{m.model && <span title={m.model}>{m.model}</span>}<code>{m.id}</code><button onClick={() => void copy(m, false)}>复制 ID</button><button onClick={() => void copy(m, true)}>复制 JSON</button></div>
              {m.blocks.map((block, n) => block.kind === 'text' ? <MessageContent key={n} text={block.text} /> : <div className="history-tool-block" key={n}>
                <details className={`history-block ${block.error ? 'failed' : ''}`}>
                  <summary><span>{block.kind === 'tool_use' ? `调用 ${block.name}` : block.kind === 'tool_result' ? `工具返回${block.error ? ' · 失败' : ''}` : block.kind === 'thinking' ? '思考内容（供应商返回）' : block.kind}</span><small>{toolPreview(block)}</small></summary>
                  {block.toolId && <div className="record-id">关联调用：{block.toolId}</div>}<pre>{block.text}</pre>
                </details>
                {block.toolId && <div className="history-tool-link"><code title={block.toolId}>{short(block.toolId)}</code>{related(block) ? <button onClick={() => jump(related(block)!.message.id)}>{block.kind === 'tool_use' ? '定位结果 ↓' : '定位调用 ↑'}</button> : <span>本页无唯一对应{block.kind === 'tool_use' ? '结果' : '调用'}</span>}</div>}
              </div>)}
              <details className="record-json"><summary>查看记录 JSON</summary><pre>{JSON.stringify(m, null, 2)}</pre></details>
            </>}
          </div>
        </article>
      </Fragment>;
    })}
    <p className="inspection-footnote">输入段按 SDK 输入组织，不等同于模型请求次数。失败筛选仅依据工具返回的错误标记；搜索、计数与工具定位仅覆盖本页。内容已脱敏，大型内容可能截断。</p>
  </section>;
}
