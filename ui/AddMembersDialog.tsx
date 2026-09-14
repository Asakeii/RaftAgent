import { useEffect, useRef, useState } from "react";
import type { Agent, Room } from "../src/contracts";

export function AddMembersDialog({ room, agents, close, submit }: {
  room: Room; agents: Agent[]; close: () => void; submit: (members: string[]) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [saving, setSaving] = useState(false); const [error, setError] = useState("");
  const available = agents.filter(agent => !room.members.includes(agent.id));
  const members = selected.filter(id => available.some(agent => agent.id === id));
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="dialog add-members-dialog" aria-labelledby="add-members-title"
    onKeyDown={event => { if (event.key === "Escape") event.stopPropagation(); }}
    onCancel={event => { event.preventDefault(); if (!saving) close(); }}>
    <form onSubmit={async event => {
      event.preventDefault(); if (!members.length || saving) return;
      setSaving(true); setError("");
      try { await submit(members); close(); }
      catch (error) { setError(error instanceof Error ? error.message : "添加失败，请重试。"); }
      finally { setSaving(false); }
    }}>
      <div className="dialog-top"><span className="eyebrow">INVITE COLLABORATORS</span><button type="button" aria-label="关闭添加成员" disabled={saving} onClick={close}>×</button></div>
      <h2 id="add-members-title">添加成员</h2>
      <p className="members-intro">邀请已有 Agent 加入「{room.name}」。</p>
      <fieldset disabled={saving} className="member-options"><legend>选择成员</legend>
        {available.map(agent => <label className="member-option" key={agent.id}>
          <input type="checkbox" aria-label={agent.name} checked={members.includes(agent.id)} onChange={event => setSelected(event.target.checked ? [...selected, agent.id] : selected.filter(id => id !== agent.id))} />
          <span className="avatar tone-0" aria-hidden="true">{agent.name.slice(0, 1).toUpperCase()}</span>
          <span className="member-option-text"><strong>{agent.name}</strong><small>{agent.role}</small></span>
        </label>)}
        {!available.length && <p className="members-empty">所有 Agent 都已在群里。可先在左侧创建 Agent，再回来添加。</p>}
      </fieldset>
      <p className="members-note">新成员接收加入后的消息；历史记录可按需查看。</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="members-actions"><span>已选 {members.length} 位</span><button type="button" className="secondary" disabled={saving} onClick={close}>取消</button><button type="submit" className="primary" disabled={saving || !members.length}>{saving ? "正在添加…" : "添加到群聊"}</button></div>
    </form>
  </dialog>;
}
