import { readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { normalizeModelEndpoint } from "./config.js";
import { DomainError } from "./store.js";
import type { ModelSettingsView } from "./contracts.js";

type SavedSettings = { yolo: boolean; version: 1; baseUrl: string; model: string; apiKey: string };
/** 与会话状态分开存储凭据，只向设置页面返回是否配置 Key。 */
export class ModelSettings {
  readonly env: NodeJS.ProcessEnv;
  readonly path: string;
  private saved = false;
  private yolo = false;
  constructor(dataDir: string, initial: NodeJS.ProcessEnv) {
    this.env = { ...initial };
    this.path = join(dataDir, "llm-settings.json");
    let text: string;
    try { text = readFileSync(this.path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw new Error("无法读取本地模型配置文件。"); }
    try {
      const data: unknown = JSON.parse(text);
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
      const value = data as Record<string, unknown>;
      if (value.version !== 1 || typeof value.baseUrl !== "string" || typeof value.model !== "string" || typeof value.apiKey !== "string") throw new Error();
      if (value.yolo !== undefined && typeof value.yolo !== "boolean") throw new Error();
      const endpoint = normalizeModelEndpoint(value.baseUrl, value.model);
      this.apply({ yolo: value.yolo === true, version: 1, ...endpoint, apiKey: this.key(value.apiKey) });
    } catch { throw new Error("本地模型配置文件无效，请检查 llm-settings.json 的格式。"); }
  }
  private key(value: string) {
    if (value.length > 8192 || /[\x00-\x1f\x7f]/.test(value)) throw new DomainError("API Key 不能包含换行或控制字符，长度不能超过 8192。");
    return value.trim();
  }
  private apply(value: SavedSettings) {
    Object.assign(this.env, { ANTHROPIC_BASE_URL: value.baseUrl, ANTHROPIC_MODEL: value.model, ANTHROPIC_API_KEY: value.apiKey });
    this.yolo = value.yolo;
    this.saved = true;
  }
  view(): ModelSettingsView {
    return { yolo: this.yolo, baseUrl: this.env.ANTHROPIC_BASE_URL?.trim() || "https://api.anthropic.com", model: this.env.ANTHROPIC_MODEL?.trim() || "", hasApiKey: !!this.env.ANTHROPIC_API_KEY?.trim(), source: this.saved ? "saved" : "environment" };
  }
  save(input: unknown): ModelSettingsView {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new DomainError("模型配置格式无效。");
    const fields = input as Record<string, unknown>;
    if (typeof fields.baseUrl !== "string" || typeof fields.model !== "string" || (fields.apiKey !== undefined && typeof fields.apiKey !== "string") || (fields.clearApiKey !== undefined && typeof fields.clearApiKey !== "boolean")) throw new DomainError("请提供正确的 API 地址、Key 和模型名。");
    if (fields.yolo !== undefined && typeof fields.yolo !== "boolean") throw new DomainError("YOLO 模式必须为布尔值。");
    let endpoint: ReturnType<typeof normalizeModelEndpoint>;
    try { endpoint = normalizeModelEndpoint(fields.baseUrl, fields.model); }
    catch (error) { throw new DomainError(error instanceof Error ? error.message : "模型配置无效。"); }
    const replacement = this.key((fields.apiKey as string | undefined) ?? "");
    if (fields.clearApiKey && replacement) throw new DomainError("不能同时清除和替换 API Key。");
    const old = this.view();
    if (old.hasApiKey && !replacement && !fields.clearApiKey && endpoint.baseUrl !== old.baseUrl.replace(/\/+$/, "")) throw new DomainError("切换 API 地址时请重新填写 Key，避免将原服务的 Key 用于新地址。");
    const apiKey = fields.clearApiKey ? "" : replacement || this.env.ANTHROPIC_API_KEY?.trim() || "";
    const next: SavedSettings = { yolo: fields.yolo as boolean | undefined ?? this.yolo, version: 1, ...endpoint, apiKey };
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try { writeFileSync(temp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600, flag: "wx" }); renameSync(temp, this.path); }
    catch { throw new Error("模型配置保存失败，请检查本地数据目录的写入权限。"); }
    finally { rmSync(temp, { force: true }); }
    this.apply(next);
    return this.view();
  }
}
