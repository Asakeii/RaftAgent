import { useEffect, useRef, useState } from "react";
import type { Agent, SharedSkill } from "../src/contracts";

type SkillRow = SharedSkill & { source: string; skill: string };
export function SkillsDialog({ agent, load, save, publish, close }: {
  agent: Agent; load: () => Promise<{ skills: SkillRow[]; directory: string }>;
  save: (ids: string[]) => Promise<unknown>; publish: (id: string) => Promise<unknown>; close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [catalog, setCatalog] = useState<SkillRow[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [directory, setDirectory] = useState("");
  const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false);
  const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  useEffect(() => {
    dialog.current?.showModal(); let active = true;
    load().then(data => { if (active) { setCatalog(data.skills); setDirectory(data.directory); setSelected(agent.skillIds ?? data.skills.filter(s => s.plugin === "raft").map(s => s.id)); } })
      .catch(e => { if (active) setError(String(e)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  return <dialog ref={dialog} className="dialog skills-dialog" aria-labelledby="skills-title"
    onKeyDown={e => { if (e.key === "Escape") e.stopPropagation(); }} onCancel={e => { e.preventDefault(); if (!busy) close(); }}>
    <form onSubmit={async e => {
      e.preventDefault(); if (loading || busy || !directory) return;
      setBusy(true); setError("");
      try { await save(selected); close(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
    }}>
      <div className="dialog-top"><span className="eyebrow">SHARED SKILL LIBRARY</span><button type="button" aria-label="关闭 Skills 配置" disabled={busy} onClick={close}>×</button></div>
      <h2 id="skills-title">{agent.name} 的 Skills</h2>
      <p className="members-intro">从共享目录选择能力。配置在下一轮运行或重新加载后生效。</p>
      {loading ? <p role="status">正在读取共享目录…</p> : <fieldset disabled={busy} className="skill-options"><legend>已选择 {selected.length} 项</legend>
        {catalog.map(skill => <div className="skill-option" key={skill.id}>
          <label><input type="checkbox" aria-label={skill.skill} checked={selected.includes(skill.id)} onChange={e => setSelected(e.target.checked ? [...selected, skill.id] : selected.filter(id => id !== skill.id))} />
            <span><strong>{skill.name}</strong><small>{skill.plugin === "raft" ? "内置能力" : "共享能力"} · {skill.version.slice(0, 8)}</small><p>{skill.description}</p></span>
          </label>
          <details><summary>维护与发布</summary><p>在下列目录修改源码，验证后发布。新版本供所有启用该 Skill 的 Agent 在后续运行中使用。</p><code>{skill.source}</code>
            <button type="button" className="secondary" disabled={busy} onClick={async () => {
              setBusy(true); setError(""); setNotice("");
              try { await publish(skill.id); const data = await load(); setCatalog(data.skills); setNotice(`${skill.name} 已发布；下次运行或重新加载后使用新版本。`); }
              catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
            }}>发布源码修改</button>
          </details>
        </div>)}
        {!catalog.length && <p>共享目录中暂无 Skills。</p>}
      </fieldset>}
      {directory && <p className="skill-directory">总目录 <code>{directory}</code></p>}
      {notice && <p role="status" className="skills-notice">{notice}</p>}
      {error && <p role="alert" className="form-error">{error}</p>}
      <button className="primary full" disabled={busy || loading || !directory}>{busy ? "正在保存…" : "保存启用配置"}</button>
    </form>
  </dialog>;
}
