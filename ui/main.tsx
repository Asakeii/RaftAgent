import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Snapshot, Agent, Room, Command } from "../src/contracts";
import "./style.css";
import { MessageContent as MarkdownMessage } from "./MessageContent";
import { SettingsDialog } from "./SettingsDialog";
import { AddMembersDialog } from "./AddMembersDialog";
import { MessageComposer } from "./MessageComposer";
import { AgentHistory, AgentTraces } from "./AgentInspection";
import "./conversation-layout.css";

const token = location.hash.slice(1) || sessionStorage.getItem("raft-token") || "";
sessionStorage.setItem("raft-token", token); history.replaceState(null, "", location.pathname);
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
async function api(path: string, data?: unknown) {
  const response = await fetch(`/api/${path}`, { headers, ...(data === undefined ? {} : { method: "POST", body: JSON.stringify(data) }) });
  const value = await response.json(); if (!response.ok) throw new Error(value.error || "请求失败"); return value;
}
const statusLabel: Record<string, string> = { idle: "待命", running: "工作中", stopped: "已停止", error: "需要处理", pending: "待领取", working: "执行中", reviewing: "待验收", done: "已完成" };
const time = (t: string) => new Date(t).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
const avatar = (name: string) => name.slice(0, 1).toUpperCase();
function App() {
  const [snapshot, setSnapshot] = useState<Snapshot>(); const [selected, setSelected] = useState<string>("");
  const [view, setView] = useState<"status" | "history" | "traces">("status"); const [selectedRun, setSelectedRun] = useState("");
  const select = (id: string) => { setSelected(id); setView("status"); setSelectedRun(""); };
  const [inspectorOpen, setInspectorOpen] = useState(() => window.matchMedia("(min-width: 1101px)").matches);
  const inspectorToggle = useRef<HTMLButtonElement>(null);
  const closeInspector = () => { setInspectorOpen(false); inspectorToggle.current?.focus(); };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && inspectorOpen) closeInspector(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [inspectorOpen]);
  const [text, setText] = useState(""); const [error, setError] = useState(""); const [online, setOnline] = useState(false);
  const [modal, setModal] = useState<"agent" | "room" | "task" | null>(null); const [busy, setBusy] = useState(false);
  const [showActivity, setShowActivity] = useState(true); const end = useRef<HTMLDivElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [memberRoomId, setMemberRoomId] = useState<string | null>(null);
  const revision = useRef(0);
  const refresh = async () => { const request = ++revision.current; try { const data = await api("state"); if (request !== revision.current) return; setSnapshot(data); setOnline(true); } catch (e) { if (request !== revision.current) return; setOnline(false); setError(String(e)); } };
  useEffect(() => {
    const controller = new AbortController(); let pending: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => { if (!pending) pending = setTimeout(() => { pending = undefined; void refresh(); }, 80); };
    const events = async () => {
      while (!controller.signal.aborted) {
        try {
          const response = await fetch("/api/events", { headers, signal: controller.signal });
          if (!response.ok || !response.body) throw new Error("事件连接失败");
          const reader = response.body.getReader();
          for (;;) { const chunk = await reader.read(); if (chunk.done) break; schedule(); }
        } catch { if (!controller.signal.aborted) setOnline(false); }
        if (!controller.signal.aborted) await new Promise(r => setTimeout(r, 1000));
      }
    };
    void refresh(); void events();
    const timer = setInterval(() => void refresh(), 10_000);
    return () => { controller.abort(); clearInterval(timer); clearTimeout(pending); };
  }, []);
  const state = snapshot?.state;
  const room = state?.rooms.find(r => r.id === selected); const agent = state?.agents.find(a => a.id === selected);
  const messages = state?.messages.filter(m => m.channel === selected) ?? [];
  const activities = showActivity ? state?.activities.filter(a => a.channel === selected) ?? [] : [];
  const timeline = [...messages.map(m => ({ at: m.at, message: m, activity: null })), ...activities.map(a => ({ at: a.at, activity: a, message: null }))].sort((a, b) => a.at.localeCompare(b.at));
  const members = room ? state?.agents.filter(a => room.members.includes(a.id)) ?? [] : agent ? [agent] : [];
  const name = (id: string) => id === "user" ? "你" : state?.agents.find(a => a.id === id)?.name ?? "Agent";
  useEffect(() => { end.current?.scrollIntoView({ behavior: "smooth" }); }, [selected, messages.length, activities.length]);
  async function command(name: string, args: Record<string, unknown>) {
    setError(""); const c: Command = { name, args, requestId: crypto.randomUUID() };
    const r = await api("command", c); await refresh(); return r.data;
  }
  const action = async (fn: () => Promise<unknown>) => { try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } };
  const send = async () => {
    if (!text.trim() || busy) return; setBusy(true);
    try { await command(room ? "room.send" : "direct.send", room ? { room: room.id, body: text, mentions: members.filter(a => text.includes(`@${a.name}`)).map(a => a.id) } : { agentId: selected, text }); setText(""); }
    catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  return <div className="app">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark">≋</span><span>raft<span className="brand-dot">.</span></span><small>LOCAL</small></div>
      <div className="sidebar-nav"><button className={`nav-home ${!selected ? "active" : ""}`} onClick={() => select("")}><span>◈</span> 工作台</button>
      <div className="nav-label">独立会话 <button aria-label="创建 Agent" onClick={() => setModal("agent")}>＋</button></div>
      {state?.agents.map((a, i) => <button key={a.id} className={`nav-item ${selected === a.id ? "active" : ""}`} onClick={() => select(a.id)}><span className={`avatar tone-${i % 3}`}>{avatar(a.name)}</span><span>{a.name}<small>{a.parentAgentId ? "子 Agent · " : ""}{statusLabel[a.status]}</small></span><i className={`status-dot ${a.status}`} /></button>)}
      {!state?.agents.length && <p className="nav-empty">添加你的第一位协作者</p>}
      <div className="nav-label">协作空间 <button aria-label="创建群聊" onClick={() => setModal("room")}>＋</button></div>
      {state?.rooms.map(r => <button key={r.id} className={`nav-item room-nav ${selected === r.id ? "active" : ""}`} onClick={() => select(r.id)}><span className="hash">#</span><span>{r.name}<small>{r.members.length} 位成员</small></span></button>)}
      </div><div className="sidebar-bottom"><button className="settings-entry" aria-label="设置" onClick={() => setSettingsOpen(true)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m9 3-.7 2.5-2.2 1.3-2.5-.6-2 3.5 1.8 1.9v2.6l-1.8 1.9 2 3.5 2.5-.6 2.2 1.3L9 23h4l.7-2.4 2.2-1.3 2.5.6 2-3.5-1.8-1.9v-2.6l1.8-1.9-2-3.5-2.5.6-2.2-1.3L13 3Z" transform="translate(1 -1) scale(.92)"/><circle cx="11.1" cy="11" r="3" /></svg><span>设置</span><span className="settings-entry-hint">模型配置</span></button><div><i className={`status-dot ${online ? "idle" : "error"}`} /> {online ? "本地服务已连接" : "正在连接…"}</div><small>独立思考 · 共同推进</small></div>
    </aside>
    <main className={`main ${selected ? "conversation-main" : ""}`}>
      <header className="topbar"><div className="breadcrumb">工作空间 <span>/</span> {room ? "群聊" : agent ? "独立会话" : "概览"}</div><div className="model-pill"><i />{snapshot?.model ?? "Claude Agent SDK"}</div></header>
      {!selected ? <section className="welcome">
        <div className="eyebrow">A SHARED SPACE FOR INDEPENDENT MINDS</div>
        <h1>让想法汇合。<br /><em>让工作向前。</em></h1>
        <p className="intro">每位 Agent 拥有自己的会话与思路。<br />把他们带进同一个空间，看见讨论如何变成行动。</p>
        <div className="welcome-actions"><button className="primary" onClick={() => setModal("agent")}>＋ 创建 Agent</button><button className="secondary" onClick={() => setModal("room")}>建立协作空间 ↗</button></div>
        {!snapshot?.ready && <div className="setup"><strong>先连接你的模型</strong><p>在设置中填写 API 地址、API Key 和模型名称，即可开始使用。</p><button className="setup-link" onClick={() => setSettingsOpen(true)}>配置模型 →</button></div>}
        <div className="overview-grid"><div><span>01 / MEMBERS</span><strong>{state?.agents.length ?? 0}</strong><p>独立 Agent</p></div><div><span>02 / SPACES</span><strong>{state?.rooms.length ?? 0}</strong><p>协作群聊</p></div><div><span>03 / IN MOTION</span><strong>{state?.agents.filter(a => a.status === "running").length ?? 0}</strong><p>正在推进</p></div></div>
        <div className="recent"><span className="section-label">最近发生</span>{state?.events.slice(-4).reverse().map(e => <div key={e.seq}><span>{e.text}</span><time>{time(e.at)}</time></div>)}{!state?.events.length && <p>创建一个 Agent，开始第一段对话。</p>}</div>
      </section> : <>
        <div className="conversation-heading">
          <div className="conversation-identity"><h2>{room ? `# ${room.name}` : agent?.name}</h2><p>{room ? `${room.members.length} 位成员 · 各自思考，按需协作` : agent?.role}</p></div>
          <div className="conversation-actions"><button className={`toggle ${showActivity ? "on" : ""}`} aria-pressed={showActivity} onClick={() => setShowActivity(!showActivity)}>◉ 工具活动</button><button ref={inspectorToggle} className={`toggle ${inspectorOpen ? "on" : ""}`} aria-label="切换状态栏" aria-expanded={inspectorOpen} aria-controls="conversation-inspector" onClick={() => setInspectorOpen(!inspectorOpen)}>▥ 状态栏</button></div>
        </div>
        <div className="timeline">
          {!timeline.length && <div className="empty-conversation"><span>{room ? "#" : "◇"}</span><h3>{room ? "一个新的协作起点" : `与 ${agent?.name} 开始对话`}</h3><p>{room ? "提出目标，或 @ 某位成员。工具活动将在这里展开。" : "这里的对话保留在这个 Agent 的独立会话中。"}</p></div>}
          {timeline.map(item => item.message ? <article className={`message ${item.message.sender === "user" ? "user-message" : ""}`} key={item.message.id}>
            <div className={`avatar ${item.message.sender === "user" ? "user-avatar" : "tone-0"}`}>{avatar(name(item.message.sender))}</div><div className="message-body"><div className="message-meta"><strong>{name(item.message.sender)}</strong><span>{item.message.sender === "user" ? "YOU" : "AGENT"}</span><time>{time(item.at)}</time></div><MarkdownMessage text={item.message.text} /></div>
          </article> : item.activity && <div className="activity" key={item.activity.id}><i className={item.activity.status === "running" ? "pulse" : ""} /><span>{name(item.activity.agentId)}</span><span>{item.activity.text}</span><time>{time(item.at)}</time></div>)}
          <div ref={end} />
        </div>
        <MessageComposer key={selected} value={text} onChange={setText} send={() => void send()} members={members} group={!!room} placeholder={room ? "描述目标，或 @ 一位成员…" : `向 ${agent?.name} 提问…`} busy={busy} online={online} stopped={agent?.status === "stopped"} />
      </>}
      {error && <div role="alert" className="toast"><span>{error}</span><button aria-label="关闭提示" onClick={() => setError("")}>×</button></div>}
    </main>
    {selected && inspectorOpen && <aside id="conversation-inspector" className="inspector conversation-inspector" aria-label="会话状态栏">
      <div className="inspector-title"><span>{agent ? "会话状态" : "空间状态"}</span><div><span>LIVE</span><button aria-label="收起状态栏" onClick={closeInspector}>×</button></div></div>
      {agent && <nav className="inspector-tabs" aria-label="状态栏视图" role="tablist" onKeyDown={event => {
        const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
        const index = tabs.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
        if (next >= 0) { event.preventDefault(); tabs[next]?.focus(); tabs[next]?.click(); }
      }}>{([['status', '状态'], ['history', '会话详情'], ['traces', '执行日志']] as const).map(([id, label]) => <button id={`inspector-tab-${id}`} aria-controls="inspector-panel" role="tab" tabIndex={view === id ? 0 : -1} aria-selected={view === id} key={id} onClick={() => setView(id)}>{label}</button>)}</nav>}
      <div id="inspector-panel" className="inspector-panel" role={agent ? "tabpanel" : undefined} aria-labelledby={agent ? `inspector-tab-${view}` : undefined}>
      {agent && view === 'history' ? <AgentHistory key={agent.id} agent={agent} api={api} onRun={id => { setSelectedRun(id); setView('traces'); }} /> : agent && view === 'traces' ? <AgentTraces key={agent.id} agent={agent} api={api} selectedRun={selectedRun} selectRun={setSelectedRun} onAgent={(id, runId) => { setSelected(id); setSelectedRun(runId); setView('traces'); }} /> : <div className="inspector-status"><div className="section-label member-section-label">成员{room && <button className="add-members-button" aria-label="添加群成员" onClick={() => setMemberRoomId(room.id)}>＋ 添加成员</button>}</div>{members.map(a => <div className="member" key={a.id}><div className="member-row"><span className="avatar tone-0">{avatar(a.name)}</span><div><strong>{a.name}</strong><small><i className={`status-dot ${a.status}`} />{statusLabel[a.status]}</small></div><button onClick={() => void action(() => command(a.status === "running" || a.status === "idle" ? "agent.stop" : "agent.resume", { id: a.id }))}>{a.status === "running" || a.status === "idle" ? "停止" : "继续"}</button></div>{a.error && <p className="member-error">{a.error}</p>}</div>)}
      {room && <><div className="section-label with-action">任务 <button aria-label="创建任务" onClick={() => setModal("task")}>＋</button></div>{state?.tasks.filter(t => t.roomId === room.id).map(t => <div className="task" key={t.id}><span className={`task-state ${t.status}`}>{statusLabel[t.status]}</span><strong>{t.title}</strong><small>{t.owner ? name(t.owner) : "等待成员领取"}</small>{t.evidence && <details><summary>查看提交说明</summary><MarkdownMessage text={t.evidence} /></details>}{t.status === "reviewing" && <button onClick={() => void action(() => command("task.complete", { id: t.id, expectedVersion: t.version }))}>核验后确认完成</button>}</div>)}{!state?.tasks.some(t => t.roomId === room.id) && <p className="muted">把目标变成可跟踪的任务。</p>}
      <div className="section-label">待处理草稿</div>{state?.drafts.filter(d => d.roomId === room.id && d.status === "held").map(d => <div className="draft" key={d.id}><small>{name(d.agentId)} · 房间有新变化</small><MarkdownMessage text={d.body} /><div><button onClick={() => void action(() => command("draft.resolve", { id: d.id, action: "retry", basedOn: room.version }))}>原样重检发送</button><button onClick={() => void action(() => command("draft.resolve", { id: d.id, action: "discard" }))}>丢弃</button></div></div>)}<div className="room-version"><span>协作版本</span><code>v{room.version}</code></div></>}
      {agent && <div className="session-info"><details className="agent-role"><summary>职责说明</summary><MarkdownMessage text={agent.role} /></details>{agent.parentAgentId && <><span className="section-label">创建者</span><p>{name(agent.parentAgentId)}</p></>}<span className="section-label">工作目录</span><p>{agent.workspace}</p><span className="section-label">会话</span><p>{agent.sessionId || "首次运行后建立"}</p></div>}
      </div>}
      </div>
    </aside>}
    {!!snapshot?.approvals.length && <div className="approval-tray">{snapshot.approvals.map(a => <div key={a.id}><div className="eyebrow">需要你的授权</div><h3>{name(a.agentId)} 请求使用 {a.tool}</h3><pre>{JSON.stringify(a.input, null, 2)}</pre><div><button className="secondary" onClick={() => void action(() => api("approval", { id: a.id, allow: false }))}>拒绝</button><button className="primary" onClick={() => void action(() => api("approval", { id: a.id, allow: true }))}>允许本次</button></div></div>)}</div>}
    {modal && <CreateDialog kind={modal} agents={state?.agents ?? []} room={room} close={() => setModal(null)} submit={async (args) => { const result = await command(modal === "agent" ? "agent.create" : modal === "room" ? "room.create" : "task.create", args); if (modal !== "task") select(result.id); setModal(null); }} />}
    {memberRoomId && state?.rooms.find(r => r.id === memberRoomId) && <AddMembersDialog room={state.rooms.find(r => r.id === memberRoomId)!} agents={state.agents} close={() => setMemberRoomId(null)} submit={async members => { await command("room.members.add", { room: memberRoomId, members }); }} />}
    {settingsOpen && <SettingsDialog load={() => api("settings")} save={async value => { const result = await api("settings", value); await refresh(); return result; }} close={() => setSettingsOpen(false)} />}
  </div>;
}
function CreateDialog({ kind, agents, room, close, submit }: { kind: "agent" | "room" | "task"; agents: Agent[]; room: Room | undefined; close: () => void; submit: (args: Record<string, unknown>) => Promise<void> }) {
  const [name, setName] = useState(""); const [role, setRole] = useState("你是一名细致的协作者，先理解目标，再执行并核验结果。"); const [members, setMembers] = useState<string[]>(agents.map(a => a.id)); const [error, setError] = useState(""); const [saving, setSaving] = useState(false);
  return <div className="modal-backdrop"><form className="dialog" onSubmit={async e => { e.preventDefault(); setSaving(true); try { await submit(kind === "agent" ? { name, role } : kind === "room" ? { name, members } : { room: room?.id, title: name }); } catch (e) { setError(String(e)); } finally { setSaving(false); } }}><div className="dialog-top"><span className="eyebrow">{kind === "agent" ? "NEW COLLABORATOR" : "MAKE ROOM FOR IDEAS"}</span><button type="button" aria-label="关闭弹窗" onClick={close}>×</button></div><h2>{kind === "agent" ? "认识一位新协作者" : kind === "room" ? "建立协作空间" : "定义一个任务"}</h2><label>{kind === "task" ? "任务目标" : "名称"}<input autoFocus required value={name} onChange={e => setName(e.target.value)} placeholder={kind === "agent" ? "例如：Atlas" : kind === "room" ? "例如：产品工作室" : "描述明确的完成目标"} /></label>{kind === "agent" && <><label>角色与职责<textarea required value={role} onChange={e => setRole(e.target.value)} /></label><small>工作目录将自动创建。文件编辑和一般命令会按 SDK 权限规则请求授权。</small></>}{kind === "room" && <fieldset><legend>邀请成员</legend>{agents.map(a => <label className="checkbox" key={a.id}><input type="checkbox" checked={members.includes(a.id)} onChange={e => setMembers(e.target.checked ? [...members, a.id] : members.filter(id => id !== a.id))} />{a.name}<small>{a.role.slice(0, 28)}</small></label>)}{!agents.length && <p>请先创建 Agent，再建立群聊。</p>}</fieldset>}{error && <p className="form-error">{error}</p>}<button className="primary full" disabled={saving}>{saving ? "正在创建…" : "创建"}</button></form></div>;
}
createRoot(document.getElementById("root")!).render(<App />);
