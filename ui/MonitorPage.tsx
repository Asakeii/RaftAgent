import React, { useEffect, useRef, useState } from 'react';
import type { Snapshot } from '../src/contracts';
import { AgentAvatar } from './Avatars';
import { AgentHistory, AgentTraces } from './AgentInspection';
import './monitor.css';
import { RunTimeline } from './RunTimeline';

const labels: Record<string, string> = { idle: '待命', running: '工作中', stopped: '已停止', error: '需要处理' };
export function MonitorPage({ snapshot, initialChannel, api, close, online }: {
  snapshot?: Snapshot; initialChannel: string; api: (path: string, data?: unknown) => Promise<any>; close: () => void; online: boolean;
}) {
  const state = snapshot?.state;
  const [channel, setChannel] = useState(initialChannel);
  const [agentId, setAgentId] = useState('');
  const [tab, setTab] = useState<'overview' | 'history' | 'traces'>('overview');
  const [run, setRun] = useState('');
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => { back.current?.focus(); }, []);
  const room = state?.rooms.find(r => r.id === channel);
  const agents = state?.agents.filter(a => !channel || a.id === channel || room?.members.includes(a.id)) ?? [];
  const agent = agents.find(a => a.id === agentId) ?? agents[0];
  const scope = room?.id ?? agent?.id;
  const runs = state?.runs.filter(r => !channel || r.channel === channel) ?? [];
  const tone = (id: string) => Math.max(0, state?.agents.findIndex(a => a.id === id) ?? 0) % 4;
  const jump = (id: string, runId: string, conversation?: string) => { setChannel(conversation || id); setAgentId(id); setRun(runId); setTab('traces'); };
  return <section className="monitor-page" aria-label="Agent 监测系统">
    <header className="monitor-header"><div><span className="monitor-brand"><strong>raft<span>.</span></strong><span>/ 监测系统</span></span><h1>Agent 监测</h1><p>从运行状态到每一次工具调用。</p></div><div className="monitor-header-actions"><span className="monitor-live"><i className={`status-dot ${online ? 'idle' : 'error'}`} />{online ? '实时连接' : '连接中'}</span><button ref={back} onClick={close}>↶ 返回工作区</button></div></header>
    <div className="monitor-stats">{[['Agent', state?.agents.length ?? 0], ['运行中', state?.runs.filter(r => r.status === 'running').length ?? 0], ['等待授权', snapshot?.approvals.length ?? 0], ['需要处理', state?.agents.filter(a => a.status === 'error').length ?? 0]].map(([name, value]) => <div key={name}><span>{name}</span><strong>{value}</strong></div>)}</div>
    <div className="monitor-filters"><label>会话范围<select aria-label="监测会话范围" value={channel} onChange={e => { setChannel(e.target.value); setAgentId(''); setRun(''); }}><option value="">全部会话</option>{state?.rooms.map(r => <option key={r.id} value={r.id}>群聊 · {r.name}</option>)}{state?.agents.map(a => <option key={a.id} value={a.id}>私聊 · {a.name}</option>)}</select></label><label>查看 Agent<select aria-label="监测 Agent" value={agent?.id ?? ''} onChange={e => { setAgentId(e.target.value); setRun(''); }}>{agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label><span>概览按会话筛选；详情显示所选成员的{room ? '群聊' : '私聊'}会话。</span></div>
    <nav className="monitor-tabs" aria-label="监测视图">{([['overview', '运行概览'], ['history', '会话详情'], ['traces', '执行日志']] as const).map(([id, title]) => <button key={id} aria-pressed={tab === id} onClick={() => setTab(id)}>{title}</button>)}</nav>
    <div className="monitor-content">
      {tab === 'overview' ? <><div className="monitor-agents">{agents.map(a => <button className="monitor-agent-card" key={a.id} onClick={() => { setAgentId(a.id); setTab('traces'); }}><AgentAvatar tone={tone(a.id)} /><div><strong>{a.name}</strong><span><i className={`status-dot ${a.status}`} />{labels[a.status]}</span></div><small>查看日志 ↗</small>{a.error && <p>{a.error}</p>}</button>)}</div>{state && <RunTimeline key={channel} runs={runs} state={state} api={api} jump={jump} />}{!agents.length && <p className="monitor-empty">当前范围没有 Agent。返回工作区创建成员或调整筛选。</p>}</> : agent && scope ? tab === 'history' ? <AgentHistory key={`${agent.id}/${scope}`} agent={agent} conversationId={scope} api={api} onRun={id => { setRun(id); setTab('traces'); }} /> : <AgentTraces key={`${agent.id}/${scope}`} agent={agent} conversationId={scope} api={api} selectedRun={run} selectRun={setRun} onAgent={jump} /> : <p className="monitor-empty">请先选择一个 Agent。</p>}
    </div>
  </section>;
}
