import { useEffect, useRef, useState } from "react";
import type { ModelSettingsView } from "../src/contracts";

export function SettingsDialog({ load, save, close }: {
  load: () => Promise<ModelSettingsView>;
  save: (value: { baseUrl: string; model: string; apiKey: string; clearApiKey: boolean }) => Promise<ModelSettingsView>;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [current, setCurrent] = useState<ModelSettingsView>();
  const [baseUrl, setBaseUrl] = useState(""); const [model, setModel] = useState(""); const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false); const [clearKey, setClearKey] = useState(false);
  const [saving, setSaving] = useState(false); const [error, setError] = useState(""); const [success, setSuccess] = useState(false);
  useEffect(() => {
    dialog.current?.showModal(); let cancelled = false;
    void load().then(value => { if (!cancelled) { setCurrent(value); setBaseUrl(value.baseUrl); setModel(value.model); } }).catch(() => { if (!cancelled) setError("无法加载设置，请关闭后重试。"); });
    return () => { cancelled = true; };
  }, []);
  const edit = () => { setSuccess(false); setError(""); };
  return <dialog ref={dialog} className="dialog settings-dialog" aria-labelledby="settings-title" onCancel={event => { event.preventDefault(); if (!saving) close(); }}>
    <form onSubmit={async event => {
      event.preventDefault(); setSaving(true); setError(""); setSuccess(false);
      try {
        const next = await save({ baseUrl, model, apiKey, clearApiKey: clearKey });
        setCurrent(next); setBaseUrl(next.baseUrl); setModel(next.model); setApiKey(""); setShowKey(false); setClearKey(false); setSuccess(true);
      } catch (error) { setError(error instanceof Error ? error.message : "保存失败，请重试。"); }
      finally { setSaving(false); }
    }}>
      <div className="dialog-top"><span className="eyebrow">WORKSPACE SETTINGS</span><button type="button" aria-label="关闭设置" disabled={saving} onClick={close}>×</button></div>
      <h2 id="settings-title">模型设置</h2>
      <p className="settings-intro">为所有 Agent 配置模型服务。</p>
      {!current ? <p className="settings-loading">{error || "正在加载配置…"}</p> : <>
        <div className="settings-status"><i className={`status-dot ${current.hasApiKey ? "idle" : "stopped"}`} /><span>{current.hasApiKey ? "API Key 已配置" : "尚未配置 API Key"}</span><small>{current.source === "saved" ? "应用设置" : "环境配置"}</small></div>
        <fieldset disabled={saving} className="settings-fields">
          <label htmlFor="llm-api-url">API 地址</label>
          <input id="llm-api-url" type="url" autoFocus autoComplete="off" spellCheck={false} maxLength={2048} value={baseUrl} onChange={e => { edit(); setBaseUrl(e.target.value); }} placeholder="https://api.anthropic.com" />
          <p className="field-hint">填写 Anthropic Messages 兼容接口的基础地址，不包含 /messages 或 /chat/completions。</p>
          <label htmlFor="llm-api-key">API Key</label>
          <div className="key-input"><input id="llm-api-key" type={showKey ? "text" : "password"} autoComplete="new-password" spellCheck={false} maxLength={8192} disabled={clearKey} value={apiKey} onChange={e => { edit(); setApiKey(e.target.value); }} placeholder={clearKey ? "保存后清除 Key" : current.hasApiKey ? "已配置，留空则保留原 Key" : "输入服务商提供的 API Key"} /><button type="button" aria-label={showKey ? "隐藏 Key" : "显示 Key"} disabled={clearKey} onClick={() => setShowKey(!showKey)}>{showKey ? "隐藏" : "显示"}</button></div>
          <div className="key-hint"><span>Key 仅保存在本机，保存后不再回显。</span>{current.hasApiKey && <label><input type="checkbox" checked={clearKey} onChange={e => { edit(); setClearKey(e.target.checked); if (e.target.checked) setApiKey(""); }} />清除 Key</label>}</div>
          <label htmlFor="llm-model">模型名称</label>
          <input id="llm-model" autoComplete="off" spellCheck={false} maxLength={256} value={model} onChange={e => { edit(); setModel(e.target.value); }} placeholder="例如：claude-sonnet-4-5 或服务商模型 ID" />
          <p className="field-hint">留空使用默认模型；火山方舟需填写模型 ID 或推理接入点 ID。</p>
        </fieldset>
        <div className="settings-note">保存后从下一次执行生效，无需重启。正在运行的任务继续使用原配置。</div>
        {error && <p className="form-error" role="alert">{error}</p>}
        {success && <p className="settings-success" role="status">{current.hasApiKey ? "配置已保存，下次执行生效。" : "配置已保存，填写 API Key 后可运行 Agent。"}</p>}
        <div className="settings-actions"><button type="button" className="secondary" disabled={saving} onClick={close}>关闭</button><button type="submit" className="primary" disabled={saving}>{saving ? "正在保存…" : "保存配置"}</button></div>
      </>}
    </form>
  </dialog>;
}
