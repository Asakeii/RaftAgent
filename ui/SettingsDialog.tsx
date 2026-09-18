import { useEffect, useRef, useState } from "react";
import type { ModelPricing, ModelSettingsView } from "../src/contracts";

export function SettingsDialog({ load, save, close }: {
  load: () => Promise<ModelSettingsView>;
  save: (value: { baseUrl: string; model: string; apiKey: string; clearApiKey: boolean; yolo: boolean; pricing: ModelPricing | null; evaluatorModel: string }) => Promise<ModelSettingsView>;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [current, setCurrent] = useState<ModelSettingsView>();
  const [baseUrl, setBaseUrl] = useState(""); const [model, setModel] = useState(""); const [apiKey, setApiKey] = useState("");
  const [inputPrice, setInputPrice] = useState(""); const [outputPrice, setOutputPrice] = useState(""); const [cachePrice, setCachePrice] = useState("");
  const [cacheEnabled, setCacheEnabled] = useState(false);
  const loadPricing = (pricing?: ModelPricing) => { setInputPrice(pricing ? String(pricing.input) : ""); setOutputPrice(pricing ? String(pricing.output) : ""); setCachePrice(pricing ? String(pricing.cacheHit) : ""); setCacheEnabled(pricing?.cacheHitEnabled ?? false); };
  const hasPricing = inputPrice !== "" || outputPrice !== "" || cachePrice !== "" || cacheEnabled;
  const [evaluatorModel, setEvaluatorModel] = useState("");
  const [yolo, setYolo] = useState(false);
  const [showKey, setShowKey] = useState(false); const [clearKey, setClearKey] = useState(false);
  const [saving, setSaving] = useState(false); const [error, setError] = useState(""); const [success, setSuccess] = useState(false);
  useEffect(() => {
    dialog.current?.showModal(); let cancelled = false;
    void load().then(value => { if (!cancelled) { setCurrent(value); setEvaluatorModel(value.evaluatorModel ?? ""); loadPricing(value.pricing); setBaseUrl(value.baseUrl); setModel(value.model); setYolo(value.yolo); } }).catch(() => { if (!cancelled) setError("无法加载设置，请关闭后重试。"); });
    return () => { cancelled = true; };
  }, []);
  const edit = () => { setSuccess(false); setError(""); };
  return <dialog ref={dialog} className="dialog settings-dialog" aria-labelledby="settings-title" onCancel={event => { event.preventDefault(); if (!saving) close(); }}>
    <form onSubmit={async event => {
      event.preventDefault(); setSaving(true); setError(""); setSuccess(false);
      try {
        const next = await save({ baseUrl, model, apiKey, clearApiKey: clearKey, yolo, evaluatorModel, pricing: hasPricing ? { input: Number(inputPrice), output: Number(outputPrice), cacheHit: Number(cachePrice), cacheHitEnabled: cacheEnabled } : null });
        setCurrent(next); setEvaluatorModel(next.evaluatorModel ?? ""); loadPricing(next.pricing); setYolo(next.yolo); setBaseUrl(next.baseUrl); setModel(next.model); setApiKey(""); setShowKey(false); setClearKey(false); setSuccess(true);
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
          <label htmlFor="llm-evaluator-model">评测模型 · 内置轨迹裁判</label>
          <input id="llm-evaluator-model" autoComplete="off" maxLength={256} value={evaluatorModel} onChange={e => { edit(); setEvaluatorModel(e.target.value); }} placeholder="留空使用当前模型" />
          <p className="field-hint">共用 API 地址和 Key；可填写同服务商的独立裁判模型。默认提供轨迹裁判，在执行日志详情中手动启动，不自动调用模型。</p>
          <label>模型成本单价 · 元/百万 tokens</label>
          <div className="pricing-fields">
            <label htmlFor="price-input">推理输入<input id="price-input" type="number" min="0" max="1000000000" step="any" required={hasPricing} value={inputPrice} placeholder="未配置" onChange={e => { edit(); setInputPrice(e.target.value); }} /></label>
            <label htmlFor="price-output">推理输出<input id="price-output" type="number" min="0" max="1000000000" step="any" required={hasPricing} value={outputPrice} placeholder="未配置" onChange={e => { edit(); setOutputPrice(e.target.value); }} /></label>
            <label htmlFor="price-cache">缓存命中<input id="price-cache" type="number" min="0" max="1000000000" step="any" required={cacheEnabled} disabled={!cacheEnabled} value={cachePrice} placeholder="未配置" onChange={e => { edit(); setCachePrice(e.target.value); }} /></label>
          </div>
          <div className="yolo-setting">
            <div><label htmlFor="price-cache-enabled">开启缓存命中计价</label><p>按 SDK 报告的命中量使用缓存价；关闭后按输入价计费，不改变服务端缓存行为。</p></div>
            <input id="price-cache-enabled" className="yolo-switch" type="checkbox" role="switch" checked={cacheEnabled} onChange={e => { edit(); setCacheEnabled(e.target.checked); }} />
          </div>
          <p className="field-hint">缓存写入按输入价计算。本轮所有模型用量统一使用这些单价；切换模型或服务商时请同步更新。保存后用于新运行，历史费用保留原价格。</p>
          <button type="button" className="secondary" onClick={() => { edit(); loadPricing(); }}>清除价格配置</button>
          <div className="yolo-setting">
            <div><label htmlFor="yolo-mode">YOLO 模式</label><p id="yolo-description">适用于所有 Agent，自动批准普通工具操作。Bash 沙箱保持开启。</p></div>
            <input id="yolo-mode" className="yolo-switch" type="checkbox" role="switch" aria-describedby="yolo-description" checked={yolo} onChange={e => { edit(); setYolo(e.target.checked); }} />
          </div>
        </fieldset>
        <div className="settings-note">模型配置下次执行生效。YOLO 保存后应用于当前及后续执行；已有授权请求仍需处理，关闭不会撤销已开始的操作。</div>
        {error && <p className="form-error" role="alert">{error}</p>}
        {success && <p className="settings-success" role="status">{current.hasApiKey ? "配置已保存，YOLO 设置已应用；模型配置下次执行生效。" : "配置已保存，填写 API Key 后可运行 Agent。"}</p>}
        <div className="settings-actions"><button type="button" className="secondary" disabled={saving} onClick={close}>关闭</button><button type="submit" className="primary" disabled={saving}>{saving ? "正在保存…" : "保存配置"}</button></div>
      </>}
    </form>
  </dialog>;
}
