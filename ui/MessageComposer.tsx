import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { AgentAvatar } from "./Avatars";
import type { Agent } from "../src/contracts";

type MentionQuery = { start: number; end: number; query: string };
function mentionAt(input: HTMLTextAreaElement): MentionQuery | null {
  if (input.selectionStart !== input.selectionEnd) return null;
  const end = input.selectionStart;
  // 邮箱中的 @ 不触发；中文标点、空格、换行之后均可开始提及。
  const match = /(?:^|[\s（(，,。;；:：!?！？])@([^\s@，,。;；:：!?！？]*)$/u.exec(input.value.slice(0, end));
  return match ? { start: end - match[1]!.length - 1, end, query: match[1]! } : null;
}

const statuses: Record<Agent["status"], string> = { idle: "待命", running: "工作中", stopped: "已停止", error: "需要处理" };

export function MessageComposer({ value, onChange, send, members, group, placeholder, busy, online, running, stop, avatarTone }: {
  avatarTone: (id: string) => number;
  value: string; onChange: (value: string) => void; send: () => void;
  members: Agent[]; group: boolean; placeholder: string; busy: boolean; online: boolean; running: boolean; stop: () => void;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const pendingCaret = useRef<number | null>(null);
  const [mention, setMention] = useState<MentionQuery | null>(null);
  const [highlight, setHighlight] = useState(0);
  const listId = useId();
  const candidates = mention ? members.filter(a => a.name.toLocaleLowerCase().includes(mention.query.toLocaleLowerCase())) : [];
  const active = Math.min(highlight, Math.max(0, candidates.length - 1));
  const open = group && !!mention && !busy;
  const activeId = open && candidates[active] ? `${listId}-${candidates[active].id}` : undefined;
  useEffect(() => { if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: "nearest" }); }, [activeId]);
  useLayoutEffect(() => {
    if (pendingCaret.current === null) return;
    input.current?.focus();
    input.current?.setSelectionRange(pendingCaret.current, pendingCaret.current);
    pendingCaret.current = null;
  });
  function updateMention(target: HTMLTextAreaElement) {
    const next = group && !composing.current ? mentionAt(target) : null;
    setMention(previous => {
      if (previous?.start === next?.start && previous?.end === next?.end && previous?.query === next?.query) return previous;
      return next;
    });
  }
  function choose(agent: Agent) {
    if (!mention) return;
    const insertion = `@${agent.name} `;
    pendingCaret.current = mention.start + insertion.length;
    onChange(value.slice(0, mention.start) + insertion + value.slice(mention.end));
    setMention(null); setHighlight(0);
  }
  useLayoutEffect(() => {
    if (!input.current) return;
    input.current.style.height = "auto";
    input.current.style.height = `${Math.min(input.current.scrollHeight, 180)}px`;
  }, [value]);
  return <div className="composer-wrap"><div className="composer">
    {open && <div className="mention-popup">
      <div className="mention-heading"><strong>提及群成员</strong><span>{candidates.length} 位 Agent</span></div>
      <div id={listId} role="listbox" aria-label="可提及的 Agent" className="mention-list">
        {candidates.map((agent, index) => <div key={agent.id} id={`${listId}-${agent.id}`} role="option" aria-selected={index === active}
          className={`mention-option ${index === active ? "active" : ""}`} onMouseEnter={() => setHighlight(index)}
          onMouseDown={event => event.preventDefault()} onClick={() => choose(agent)}>
          <AgentAvatar tone={avatarTone(agent.id)} />
          <span className="mention-person"><strong>{agent.name}</strong><small>{agent.role}</small></span>
          <span className="mention-status"><i className={`status-dot ${agent.status}`} />{statuses[agent.status]}</span>
        </div>)}
      </div>
      {!candidates.length && <p className="mention-empty" role="status">没有匹配的群成员</p>}
      <div className="mention-help">↑ ↓ 选择 <span>Enter / Tab 确认</span><span>Esc 关闭</span></div>
    </div>}
    {group && <button className="mention-trigger" aria-label="提及成员" title="提及成员" disabled={busy} onClick={() => {
      const next = value + (value && !/\s$/.test(value) ? " @" : "@");
      pendingCaret.current = next.length; onChange(next); setHighlight(0);
      setMention({ start: next.length - 1, end: next.length, query: "" });
    }}>@</button>}
    <textarea rows={1} ref={input} aria-label="输入消息" aria-autocomplete={group ? "list" : undefined}
      aria-controls={open ? listId : undefined} aria-activedescendant={activeId}
      placeholder={placeholder} value={value} readOnly={busy}
      onChange={event => { onChange(event.target.value); setHighlight(0); updateMention(event.target); }}
      onClick={event => updateMention(event.currentTarget)} onBlur={() => setMention(null)}
      onCompositionStart={() => { composing.current = true; setMention(null); }}
      onCompositionEnd={event => { composing.current = false; updateMention(event.currentTarget); }}
      onKeyUp={event => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) updateMention(event.currentTarget); }}
      onKeyDown={event => {
        if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (open) {
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setMention(null); return; }
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setHighlight(candidates.length ? (active + (event.key === "ArrowDown" ? 1 : -1) + candidates.length) % candidates.length : 0); return;
          }
          if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
            if (candidates[active]) { event.preventDefault(); choose(candidates[active]); }
            else if (event.key === "Enter") event.preventDefault();
            return;
          }
        }
        if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); if (online && !busy && !running) { setMention(null); send(); } }
      }} />
    <div className="composer-bottom"><button className={`send ${running ? "stop-send" : ""}`} aria-label={running ? "停止回复" : "发送消息"} title={running ? "停止当前会话的回复" : "发送消息"} disabled={busy || !online || (!running && !value.trim())} onClick={() => { setMention(null); if (running) stop(); else send(); }}>{running ? <span className="stop-square" aria-hidden="true" /> : "↑"}</button></div>
  </div><small>{running ? "正在回复 · 点击方块停止，可先编辑下一条消息" : "Enter 发送 · Shift + Enter 换行"}</small></div>;
}
