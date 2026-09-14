import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isIP } from "node:net";
import { DomainError } from "./store.js";
import type { Command } from "./contracts.js";

export function readTavilyKey(dataDir: string, env: NodeJS.ProcessEnv): string {
  let key: unknown = env.TAVILY_API_KEY;
  try {
    const value = JSON.parse(readFileSync(join(dataDir, "tavily-settings.json"), "utf8"));
    if (value?.version !== 1 || typeof value.apiKey !== "string") throw new Error();
    key = value.apiKey;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new DomainError("本地 Tavily 配置无效或无法读取。");
  }
  if (typeof key !== "string" || !key.trim()) throw new DomainError("尚未配置 Tavily API Key，请在本机配置 tavily-settings.json 或 TAVILY_API_KEY。");
  if (key.length > 8192 || /[\x00-\x1f\x7f]/.test(key)) throw new DomainError("Tavily API Key 格式无效。");
  return key.trim();
}

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new DomainError(`${name} 必须是非空文本，最长 ${max} 字符。`);
  return value.trim();
}
function integer(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) throw new DomainError(`数量必须是 1–${max} 的整数。`);
  return value;
}
function publicUrl(value: unknown): string {
  const raw = text(value, "URL", 2048);
  let url: URL;
  try { url = new URL(raw); } catch { throw new DomainError("请提供有效的公网 HTTP(S) URL。"); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || !url.hostname.includes(".") || isIP(url.hostname) || url.hostname.includes(":") || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(url.hostname)) throw new DomainError("仅支持无凭证的公网网站 URL，不接受本地地址或 IP 地址。");
  url.hash = ""; return url.href;
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** 宿主读取凭据，SDK 只通过 Bash/CLI 获取脱敏后的搜索资料。 */
export class TavilyService {
  private active = 0;
  constructor(private key: () => string, private request: typeof fetch = fetch) {}
  async execute(command: Command, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    const a = command.args;
    let endpoint: "search" | "extract";
    let body: Record<string, unknown>;
    let limit = 5; let maxChars = 12000;
    if (command.name === "web.search") {
      if (Object.keys(a).some(k => !["query", "limit", "timeRange", "domains"].includes(k))) throw new DomainError("搜索参数仅支持 query、limit、timeRange 和 domains。");
      const query = text(a.query, "查询", 1000);
      limit = integer(a.limit, 5, 10);
      if (a.timeRange !== undefined && !["day", "week", "month", "year"].includes(String(a.timeRange))) throw new DomainError("time-range 仅支持 day、week、month、year。");
      if (a.domains !== undefined && (!Array.isArray(a.domains) || a.domains.length > 10 || a.domains.some(v => typeof v !== "string" || v.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(v)))) throw new DomainError("domains 应为最多 10 个域名，不包含协议或路径。");
      endpoint = "search";
      body = { query, max_results: limit, search_depth: "basic", topic: "general", auto_parameters: false, include_answer: false, include_raw_content: false, include_images: false, include_usage: true,
        ...(a.timeRange ? { time_range: a.timeRange } : {}), ...(a.domains ? { include_domains: a.domains } : {}) };
    } else if (command.name === "web.fetch") {
      if (Object.keys(a).some(k => !["url", "maxChars"].includes(k))) throw new DomainError("正文提取参数仅支持 url 和 maxChars。");
      maxChars = integer(a.maxChars, 12000, 30000);
      endpoint = "extract";
      body = { urls: [publicUrl(a.url)], extract_depth: "basic", format: "markdown", include_images: false, include_usage: true, timeout: 20 };
    } else throw new DomainError("未知联网命令，仅支持 web.search 和 web.fetch。");
    if (this.active >= 3) throw new DomainError("联网请求繁忙，请稍后重试。");
    const apiKey = this.key();
    this.active++;
    try {
      const combined = AbortSignal.any([signal, AbortSignal.timeout(25_000)]);
      const response = await this.request(`https://api.tavily.com/${endpoint}`, { method: "POST", redirect: "error", signal: combined,
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!response.ok) {
        await response.body?.cancel();
        const reasons: Record<number, string> = { 401: "Key 无效", 403: "访问被拒绝，请检查 Key 权限", 429: "请求频率超限", 432: "Key 用量超限", 433: "套餐用量超限" };
        throw new DomainError(`Tavily HTTP ${response.status}：${reasons[response.status] ?? "服务请求失败"}。未自动重试。`);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new DomainError("Tavily 返回了空响应。");
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) {
          const part = await reader.read(); if (part.done) break;
          size += part.value.length;
          if (size > 2_000_000) { await reader.cancel(); throw new DomainError("Tavily 响应超过 2 MB，请缩小查询。"); }
          chunks.push(part.value);
        }
      } finally { reader.releaseLock(); }
      signal.throwIfAborted();
      const data = object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (!Array.isArray(data.results)) throw new DomainError("Tavily 返回的数据格式无效。");
      const clip = (v: unknown, n: number) => typeof v === "string" ? v.split(apiKey).join("[REDACTED]").slice(0, n) : "";
      const results = data.results.slice(0, endpoint === "search" ? limit : 1).flatMap(raw => {
        const row = object(raw);
        let url: string; try { url = publicUrl(row.url); } catch { return []; }
        const content = typeof row.raw_content === "string" ? row.raw_content : row.content;
        return [{ title: clip(row.title, 300), url, content: clip(content, endpoint === "search" ? 2500 : maxChars), truncated: typeof content === "string" && content.length > (endpoint === "search" ? 2500 : maxChars),
          ...(typeof row.score === "number" ? { score: row.score } : {}) }];
      });
      if (endpoint === "extract" && !results.some(r => r.content)) throw new DomainError("Tavily 未能提取该网页正文，可能无法访问或不支持；未自动重试。");
      const usage = object(data.usage);
      const result = { provider: "tavily", depth: "basic", retrievedAt: new Date().toISOString(), ...(endpoint === "search" ? { query: body.query } : {}), results,
        ...(typeof usage.credits === "number" ? { credits: usage.credits } : {}), ...(typeof data.request_id === "string" ? { requestId: data.request_id } : {}) };
      return JSON.parse(JSON.stringify(result).split(apiKey).join("[REDACTED]"));
    } catch (error) {
      if (error instanceof DomainError) throw error;
      if (signal.aborted) throw new DomainError("运行已停止，联网请求已取消；已发出的请求仍可能计费。");
      throw new DomainError("Tavily 网络请求超时、失败或响应无法解析；未自动重试。");
    } finally { this.active--; }
  }
}
