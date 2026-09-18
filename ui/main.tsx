import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Snapshot, Agent, Room, Command } from "../src/contracts";
import "./style.css";
import { MessageContent as MarkdownMessage } from "./MessageContent";
import { SettingsDialog } from "./SettingsDialog";
import { SkillsDialog } from "./SkillsDialog";
import { AddMembersDialog } from "./AddMembersDialog";
import { MessageComposer } from "./MessageComposer";
import { MonitorPage } from "./MonitorPage";
import "./conversation-layout.css";
import { AgentAvatar, GroupAvatar } from "./Avatars";

const token = location.hash.slice(1) || sessionStorage.getItem("raft-token") || "";
sessionStorage.setItem("raft-token", token); history.replaceState(null, "", location.pathname);
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
async function api(path: string, data?: unknown) {
  const response = await fetch(`/api/${path}`, { headers, ...(data === undefined ? {} : { method: "POST", body: JSON.stringify(data) }) });
  const value = await response.json(); if (!response.ok) throw new Error(value.error || "请求失败"); return value;
}
const statusLabel: Record<string, string> = { idle: "待命", running: "工作中", stopped: "已停止", error: "需要处理", pending: "待领取", working: "执行中", reviewing: "待验收", done: "已完成" };
const time = (t: string) => new Date(t).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
function App() {
  const [skillsAgentId, setSkillsAgentId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot>(); const [selected, setSelected] = useState<string>("");
  const [monitorOpen, setMonitorOpen] = useState(false);
  const monitorTrigger = useRef<HTMLButtonElement>(null);
  const monitorOrigin = useRef<HTMLElement | null>(null);
  const [monitorRetained, setMonitorRetained] = useState(false);
  const openMonitor = () => { monitorOrigin.current = document.activeElement as HTMLElement; setMonitorRetained(true); setMonitorOpen(true); };
  useEffect(() => { if (!monitorOpen) { const timer = setTimeout(() => setMonitorRetained(false), 650); return () => clearTimeout(timer); } }, [monitorOpen]);
  const closeMonitor = () => { setMonitorOpen(false); requestAnimationFrame(() => (monitorOrigin.current ?? monitorTrigger.current)?.focus()); };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && monitorOpen) closeMonitor(); };
    document.addEventListener("keydown", onKey); return () => document.removeEventListener("keydown", onKey);
  }, [monitorOpen]);
  const select = (id: string) => { setSelected(id); };
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [search, setSearch] = useState("");
  const inspectorToggle = useRef<HTMLButtonElement>(null);
  const closeInspector = () => { setInspectorOpen(false); inspectorToggle.current?.focus(); };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && inspectorOpen && !monitorOpen) closeInspector(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [inspectorOpen, monitorOpen]);
  const [text, setText] = useState(""); const [error, setError] = useState(""); const [online, setOnline] = useState(false);
  const [modal, setModal] = useState<"agent" | "room" | "task" | null>(null); const [busy, setBusy] = useState(false);
  const followLatest = useRef(true);
  const [showActivity, setShowActivity] = useState(false); const end = useRef<HTMLDivElement>(null);
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
  const messages = [...(state?.messages ?? []), ...(snapshot?.streamingMessages ?? [])].filter(m => m.channel === selected && !m.internalFor && !m.retractionOf);
  const running = state?.runs.filter(r => r.status === "running" && r.channel === selected) ?? [];
  const runningAgents = [...new Set(running.map(r => r.agentId))];
  const activities = showActivity ? state?.activities.filter(a => a.channel === selected) ?? [] : [];
  const timeline = [...messages.map(m => ({ at: m.at, message: m, activity: null })), ...activities.map(a => ({ at: a.at, activity: a, message: null }))].sort((a, b) => a.at.localeCompare(b.at));
  const members = room ? state?.agents.filter(a => room.members.includes(a.id)) ?? [] : agent ? [agent] : [];
  const name = (id: string) => id === "user" ? "你" : state?.agents.find(a => a.id === id)?.name ?? "已删除的 Agent";
  useEffect(() => { followLatest.current = true; end.current?.scrollIntoView({ behavior: "instant" }); }, [selected]);
  const contentVersion = messages.map(m => `${m.id}:${m.text.length}`).join("|");
  useEffect(() => { if (followLatest.current) end.current?.scrollIntoView({ behavior: "instant" }); }, [contentVersion, runningAgents.join("|"), activities.length]);
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
  const stop = async () => {
    if (busy || !running.length) return;
    setBusy(true);
    try { await command("conversation.stop", { channel: selected, runIds: running.map(r => r.id) }); }
    catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  const tone = (id: string) => Math.max(0, state?.agents.findIndex(a => a.id === id) ?? 0) % 4;
  const preview = (id: string, fallback: string) => {
    const last = state?.messages.filter(m => m.channel === id && !m.internalFor).at(-1);
    return last ? `${last.sender === "user" ? "你：" : ""}${last.text.replace(/[#*`\n]/g, " ")}` : fallback;
  };
  const matches = (value: string) => value.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase());
  const visibleRooms = state?.rooms.filter(r => matches(r.name)) ?? [];
  const visibleAgents = state?.agents.filter(a => matches(a.name)) ?? [];
  return <div className="workspace-stage"><div className={`workspace-flipper ${monitorOpen ? "is-monitor" : ""}`}><div className="workspace-face workspace-front" inert={monitorOpen} aria-hidden={monitorOpen}><div className={`app ${selected ? "has-conversation" : ""}`}>
    <aside className="sidebar">
      <div className="sidebar-top"><button className="brand" aria-label="回到工作台" onClick={() => select("")}>raft<span>.</span></button><div className="create-actions"><button title="创建群聊" aria-label="创建群聊" onClick={() => setModal("room")}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M17 4a4 4 0 0 1 0 8M22 21v-2a4 4 0 0 0-3-3.87"/><circle cx="9" cy="7" r="4"/></svg></button><button aria-label="创建 Agent" title="创建 Agent" onClick={() => setModal("agent")}>＋</button></div></div>
      <label className="conversation-search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="10.5" cy="10.5" r="7"/><path d="m16 16 5 5"/></svg><input aria-label="搜索会话" placeholder="搜索" value={search} onChange={e => setSearch(e.target.value)} />{search && <button aria-label="清除搜索" onClick={() => setSearch("")}>×</button>}</label>
      <nav className="sidebar-nav" aria-label="会话列表">
        {visibleRooms.map(r => <button key={r.id} className={`nav-item room-nav ${selected === r.id ? "active" : ""}`} onClick={() => select(r.id)}><GroupAvatar tones={r.members.map(tone)} /><span className="nav-copy"><strong>{r.name}</strong><small>{preview(r.id, `${r.members.length} 位成员 · 开始群聊`)}</small></span></button>)}
        {visibleAgents.map(a => <button key={a.id} className={`nav-item ${selected === a.id ? "active" : ""}`} onClick={() => select(a.id)}><AgentAvatar tone={tone(a.id)} /><span className="nav-copy"><strong>{a.name}</strong><small>{preview(a.id, a.role || statusLabel[a.status])}</small></span>{a.status === "running" && <i className="status-dot running" title="工作中" />}{a.status === "error" && <i className="status-dot error" title="需要处理" />}</button>)}
        {!visibleRooms.length && !visibleAgents.length && <p className="nav-empty">{search ? "没有找到匹配的会话" : "点击上方 ＋，添加第一位 Agent"}</p>}
      </nav>
      <div className="sidebar-bottom"><button ref={monitorTrigger} className="monitor-entry" onClick={openMonitor}>◫ Agent 监测 ↗</button><button className="nav-home" aria-label="◈ 工作台" onClick={() => select("")}><span className="home-icon">▦</span>工作台</button><button className="settings-entry" aria-label="设置" onClick={() => setSettingsOpen(true)}><span className="profile-avatar">A</span><span>本地工作空间<small><i className={`status-dot ${online ? "idle" : "error"}`} />{online ? "已连接" : "正在连接…"}</small></span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3" fill="currentColor"/><circle cx="15" cy="17" r="3" fill="currentColor"/></svg></button></div>
    </aside>
    <main className={`main ${selected ? "conversation-main" : ""}`}>
      {!selected && <header className="topbar"><div className="breadcrumb">工作空间 <span>/</span> {room ? "群聊" : agent ? "独立会话" : "概览"}</div><div className="model-pill"><i />{snapshot?.model ?? "Claude Agent SDK"}</div></header>}
      {!selected ? <section className="welcome">
        <div className="welcome-mascots"><AgentAvatar tone={0} /><AgentAvatar tone={1} /><AgentAvatar tone={2} /></div>
        <h1>从一段对话开始</h1>
        <p className="intro">和你的 Agent 聊聊，或邀请他们一起协作。</p>
        <div className="welcome-actions"><button className="primary" onClick={() => setModal("agent")}>＋ 创建 Agent</button><button className="secondary" onClick={() => setModal("room")}>创建群聊</button></div>
        {!snapshot?.ready && <div className="setup"><strong>先连接你的模型</strong><p>在设置中填写 API 地址、API Key 和模型名称，即可开始使用。</p><button className="setup-link" onClick={() => setSettingsOpen(true)}>配置模型 →</button></div>}

      </section> : <>
        <div className="conversation-heading">
          <button className="back-to-chats" aria-label="返回会话列表" onClick={() => select("")}>‹</button>
          {room ? <GroupAvatar tones={room.members.map(tone)} /> : <AgentAvatar tone={tone(selected)} />}
          <div className="conversation-identity"><h2>{room?.name ?? agent?.name}</h2><p>{room ? `${room.members.length} 位成员` : statusLabel[agent?.status ?? "idle"]}</p></div>
          <div className="conversation-actions"><button className="toggle" onClick={openMonitor}>监测系统</button><button className="toggle delete-conversation" disabled={busy} onClick={() => {
            const title = room ? "群聊" : "Agent";
            const detail = room ? "将删除群消息、任务及草稿，群成员本身不受影响。" : "将删除私聊记录并退出所有群聊，其他群中的历史发言保留。";
            if (window.confirm(`删除${title}“${room?.name ?? agent?.name}”？\n${detail}工作目录、共享 Skills 和 SDK 原始文件保留。此操作不可撤销。`)) {
              void action(async () => { await command(room ? "room.delete" : "agent.delete", { id: selected }); select(""); });
            }
          }}>{room ? "删除群聊" : "删除 Agent"}</button>{agent && <button className="toggle" onClick={() => setSkillsAgentId(agent.id)}>Skills</button>}<button className={`toggle ${showActivity ? "on" : ""}`} aria-pressed={showActivity} onClick={() => setShowActivity(!showActivity)}>工具活动</button><button ref={inspectorToggle} className={`info-toggle ${inspectorOpen ? "on" : ""}`} title="成员与任务" aria-label="切换状态栏" aria-expanded={inspectorOpen} aria-controls="conversation-inspector" onClick={() => setInspectorOpen(!inspectorOpen)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7v1"/></svg></button></div>
        </div>
        <div className="timeline" onScroll={e => { const el = e.currentTarget; followLatest.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100; }}>
          {!timeline.length && <div className="empty-conversation"><span>{room ? "#" : "◇"}</span><h3>{room ? "一个新的协作起点" : `与 ${agent?.name} 开始对话`}</h3><p>{room ? "提出目标，或 @ 某位成员。工具活动将在这里展开。" : "这里的对话保留在这个 Agent 的独立会话中。"}</p></div>}
          {timeline.map(item => item.message ? <article className={`message ${item.message.sender === "user" ? "user-message" : ""}`} key={item.message.id}>
            <AgentAvatar tone={tone(item.message.sender)} /><div className="message-body"><div className={`message-meta speaker-${tone(item.message.sender)}`}><strong>{name(item.message.sender)}</strong><time>{time(item.at)}</time></div><div className={`message-bubble ${item.message.delivery === "streaming" ? "streaming-bubble" : ""}`}>{item.message.retractedAt ? <small className="retracted-note">消息已撤回{item.message.retractionReason ? ` · ${item.message.retractionReason}` : ""}</small> : <>{!!item.message.mentions.length && <div className="message-mentions" aria-label="提及的成员">{item.message.mentions.map(id => <span key={id}>@{name(id)}</span>)}</div>}<MarkdownMessage text={item.message.text} /></>}{room && item.message.delivery === "streaming" && <small className="streaming-note">正在拟稿</small>}{item.message.delivery === "interrupted" && <small className="interrupted-note">已停止</small>}</div>{room && !item.message.retractedAt && item.message.delivery !== "streaming" && <button className="retract-message" aria-label={`撤回 ${name(item.message.sender)} 的消息`} onClick={() => void action(() => command("room.retract", { id: item.message!.id, reason: "用户撤回" }))}>撤回</button>}</div>
          </article> : item.activity && <div className="activity" key={item.activity.id}><i className={item.activity.status === "running" ? "pulse" : ""} /><span>{name(item.activity.agentId)}</span><span>{item.activity.text}</span><time>{time(item.at)}</time></div>)}
          {runningAgents.length > 0 && (room ? <div className="group-loading" role="status" aria-label="群成员正在协作"><div className="running-avatar-stack" aria-hidden="true">{runningAgents.map(id => <AgentAvatar key={id} tone={tone(id)} />)}</div><span className="running-members">{runningAgents.map(name).join("、")}<small>正在协作</small></span><div className="typing-dots" aria-hidden="true"><i /><i /><i /></div></div> : runningAgents.map(id => <article className="message loading-message" key={`loading-${id}`} role="status" aria-label={`${name(id)} 正在回复`}><AgentAvatar tone={tone(id)} /><div className="message-body"><div className={`message-meta speaker-${tone(id)}`}><strong>{name(id)}</strong></div><div className="typing-dots" aria-hidden="true"><i /><i /><i /></div></div></article>))}
          {room && state?.drafts.some(d => d.roomId === room.id && d.status === "held") && <button className="held-replies" onClick={() => { setInspectorOpen(true); }}>有 {state.drafts.filter(d => d.roomId === room.id && d.status === "held").length} 条回复等待重新核验 · 查看草稿</button>}
          {agent?.error && !running.length && <p className="conversation-error" role="status">{agent.error}</p>}
          <div ref={end} />
        </div>
        <MessageComposer avatarTone={tone} key={selected} value={text} onChange={setText} send={() => void send()} members={members} group={!!room} placeholder={`给 ${room?.name ?? agent?.name} 发消息`} busy={busy} online={online} running={running.length > 0} stop={() => void stop()} />
      </>}
      {error && <div role="alert" className="toast"><span>{error}</span><button aria-label="关闭提示" onClick={() => setError("")}>×</button></div>}
    </main>
    {selected && inspectorOpen && <aside id="conversation-inspector" className="inspector conversation-inspector" aria-label="会话状态栏">
      <div className="inspector-title"><span>{agent ? "会话状态" : "空间状态"}</span><div><span>LIVE</span><button aria-label="收起状态栏" onClick={closeInspector}>×</button></div></div>
      <div id="inspector-panel" className="inspector-panel"><div className="inspector-status"><div className="section-label member-section-label">成员{room && <button className="add-members-button" aria-label="添加群成员" onClick={() => setMemberRoomId(room.id)}>＋ 添加成员</button>}</div>{members.map(a => <div className="member" key={a.id}><div className="member-row"><AgentAvatar tone={tone(a.id)} /><div><strong>{a.name}</strong><small><i className={`status-dot ${a.status}`} />{statusLabel[a.status]}</small></div></div>{a.error && <p className="member-error">{a.error}</p>}</div>)}
      {room && <><div className="section-label with-action">任务 <button aria-label="创建任务" onClick={() => setModal("task")}>＋</button></div>{state?.tasks.filter(t => t.roomId === room.id).map(t => <div className="task" key={t.id}><span className={`task-state ${t.status}`}>{statusLabel[t.status]}</span><strong>{t.title}</strong><small>{t.owner ? name(t.owner) : "等待成员领取"}</small>{t.evidence && <details><summary>查看提交说明</summary><MarkdownMessage text={t.evidence} /></details>}{t.status === "reviewing" && <button onClick={() => void action(() => command("task.complete", { id: t.id, expectedVersion: t.version }))}>核验后确认完成</button>}</div>)}{!state?.tasks.some(t => t.roomId === room.id) && <p className="muted">把目标变成可跟踪的任务。</p>}
      <div className="section-label">待处理草稿</div>{state?.drafts.filter(d => d.roomId === room.id && d.status === "held").map(d => <div className="draft" key={d.id}><small>{name(d.agentId)} · 房间有新变化</small><MarkdownMessage text={d.body} /><div><button onClick={() => void action(() => command("draft.resolve", { id: d.id, action: "retry", basedOn: room.version }))}>原样重检发送</button><button onClick={() => void action(() => command("draft.resolve", { id: d.id, action: "discard" }))}>丢弃</button></div></div>)}<div className="room-version"><span>协作版本</span><code>v{room.version}</code></div></>}
      {agent && <div className="session-info"><details className="agent-role"><summary>职责说明</summary><MarkdownMessage text={agent.role} /></details>{agent.parentAgentId && <><span className="section-label">创建者</span><p>{name(agent.parentAgentId)}</p></>}<span className="section-label">工作目录</span><p>{agent.workspace}</p><span className="section-label">会话</span><p>{state?.sessions?.find(s => s.agentId === agent.id && s.channel === agent.id)?.sdkSessionId || "首次私聊运行后建立"}</p></div>}
      </div>
      </div>
    </aside>}
    {!!snapshot?.approvals.length && <div className="approval-tray">{snapshot.approvals.map(a => <div key={a.id}><div className="eyebrow">需要你的授权</div><h3>{name(a.agentId)} 请求使用 {a.tool}</h3><pre>{JSON.stringify(a.input, null, 2)}</pre><div><button className="secondary" onClick={() => void action(() => api("approval", { id: a.id, allow: false }))}>拒绝</button><button className="primary" onClick={() => void action(() => api("approval", { id: a.id, allow: true }))}>允许本次</button></div></div>)}</div>}
    {modal && <CreateDialog kind={modal} agents={state?.agents ?? []} room={room} close={() => setModal(null)} submit={async (args) => { const result = await command(modal === "agent" ? "agent.create" : modal === "room" ? "room.create" : "task.create", args); if (modal !== "task") select(result.id); setModal(null); }} />}
    {memberRoomId && state?.rooms.find(r => r.id === memberRoomId) && <AddMembersDialog room={state.rooms.find(r => r.id === memberRoomId)!} agents={state.agents} close={() => setMemberRoomId(null)} submit={async members => { await command("room.members.add", { room: memberRoomId, members }); }} />}
    {skillsAgentId && state?.agents.find(a => a.id === skillsAgentId) && <SkillsDialog key={skillsAgentId} agent={state.agents.find(a => a.id === skillsAgentId)!} load={() => api("skills")} save={ids => command("skill.configure", { agentId: skillsAgentId, ids })} publish={id => command("skill.publish", { id })} close={() => setSkillsAgentId(null)} />}
    {settingsOpen && <SettingsDialog load={() => api("settings")} save={async value => { const result = await api("settings", value); await refresh(); return result; }} close={() => setSettingsOpen(false)} />}
  </div></div><div className="workspace-face workspace-back" inert={!monitorOpen} aria-hidden={!monitorOpen}>{(monitorOpen || monitorRetained) && <MonitorPage snapshot={snapshot} initialChannel={selected} api={api} close={closeMonitor} online={online} />}</div></div></div>;
}
function CreateDialog({ kind, agents, room, close, submit }: { kind: "agent" | "room" | "task"; agents: Agent[]; room: Room | undefined; close: () => void; submit: (args: Record<string, unknown>) => Promise<void> }) {
  const [name, setName] = useState(""); const [role, setRole] = useState("你是一名细致的协作者，先理解目标，再执行并核验结果。"); const [members, setMembers] = useState<string[]>(agents.map(a => a.id)); const [error, setError] = useState(""); const [saving, setSaving] = useState(false);
  return <div className="modal-backdrop"><form className="dialog" onSubmit={async e => { e.preventDefault(); setSaving(true); try { await submit(kind === "agent" ? { name, role } : kind === "room" ? { name, members } : { room: room?.id, title: name }); } catch (e) { setError(String(e)); } finally { setSaving(false); } }}><div className="dialog-top"><span className="eyebrow">{kind === "agent" ? "AGENT" : "RAFT"}</span><button type="button" aria-label="关闭弹窗" onClick={close}>×</button></div><h2>{kind === "agent" ? "创建 Agent" : kind === "room" ? "创建群聊" : "定义一个任务"}</h2><label>{kind === "task" ? "任务目标" : "名称"}<input autoFocus required value={name} onChange={e => setName(e.target.value)} placeholder={kind === "agent" ? "例如：Atlas" : kind === "room" ? "例如：产品工作室" : "描述明确的完成目标"} /></label>{kind === "agent" && <><label>角色与职责<textarea required value={role} onChange={e => setRole(e.target.value)} /></label><small>工作目录将自动创建。文件编辑和一般命令会按 SDK 权限规则请求授权。</small></>}{kind === "room" && <fieldset><legend>邀请成员</legend>{agents.map(a => <label className="checkbox" key={a.id}><input type="checkbox" checked={members.includes(a.id)} onChange={e => setMembers(e.target.checked ? [...members, a.id] : members.filter(id => id !== a.id))} />{a.name}<small>{a.role.slice(0, 28)}</small></label>)}{!agents.length && <p>请先创建 Agent，再建立群聊。</p>}</fieldset>}{error && <p className="form-error">{error}</p>}<button className="primary full" disabled={saving}>{saving ? "正在创建…" : "创建"}</button></form></div>;
}
createRoot(document.getElementById("root")!).render(<App />);
