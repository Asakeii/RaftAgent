import type { Options } from "@anthropic-ai/claude-agent-sdk";

export function normalizeModelEndpoint(base: string, modelName: string) {
  const baseUrl = (base.trim() || "https://api.anthropic.com").replace(/\/+$/, "");
  const model = modelName.trim();
  if (baseUrl.length > 2048 || model.length > 256 || /[\r\n\x00]/.test(baseUrl + model)) throw new Error("API 地址或模型名格式无效或过长。");
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new Error("API 地址必须是有效的 HTTP(S) 基础地址。"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("ANTHROPIC_BASE_URL 必须是无凭证、查询参数或片段的 HTTP(S) 基础地址。");
  }
  if (/\/(chat\/completions|messages)$/.test(url.pathname)) {
    throw new Error("ANTHROPIC_BASE_URL 应填写 Anthropic 兼容接口的基础地址，不能填写 /chat/completions 或 /messages 完整接口。");
  }
  if (url.hostname === "ark.cn-beijing.volces.com" && !model) throw new Error("使用火山方舟时必须设置 ANTHROPIC_MODEL（模型 ID 或推理接入点 ID）。");
  return { baseUrl, model };
}

export function createAgentOptions(
  env: NodeJS.ProcessEnv,
  cwd: string,
  abortController: AbortController,
): Options {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("请先在左下角设置中填写 API Key，或设置 ANTHROPIC_API_KEY 环境变量。");
  }

  const { baseUrl, model } = normalizeModelEndpoint(env.ANTHROPIC_BASE_URL ?? "", env.ANTHROPIC_MODEL ?? "");

  return {
    cwd,
    // SDK 的 env 会替换子进程环境，因此显式保留 PATH 等继承变量。
    env: { ...env, ANTHROPIC_API_KEY: apiKey, ANTHROPIC_BASE_URL: baseUrl },
    abortController,
    settingSources: [],
    strictMcpConfig: true,
    mcpServers: {},
    systemPrompt:
      "你是 RaftAgent，一个简洁、可靠的助手。默认使用中文回答。" +
      "需要了解项目时，使用只读工具查看相关文件；不要编造文件内容或执行结果。" +
      "不要读取 .env、密钥或其他凭证文件。",
    tools: ["Read", "Glob", "Grep"],
    allowedTools: ["Read", "Glob", "Grep"],
    ...(model ? { model } : {}),
    maxTurns: 10,
  };
}
