// 真实模型 → Skill → Bash/raftctl → Tavily；使用临时 Agent，不改变用户会话。
import { config } from "dotenv";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import assert from "node:assert/strict";
import { ModelSettings } from "../src/model-settings.js";
import { readTavilyKey } from "../src/tavily.js";
import { startService } from "../src/server.js";
import { runSession } from "../src/agent.js";
import { sendControl } from "../src/control.js";
import type { Agent } from "../src/contracts.js";

config({ quiet: true });
const dataDir = process.env.RAFT_DATA_DIR || join(homedir(), "Library/Application Support/RaftAgent");
const settings = new ModelSettings(dataDir, process.env);
const tavilyKey = readTavilyKey(dataDir, process.env);
const dir = await mkdtemp(join(tmpdir(), "raft-tavily-live-"));
const secrets = [tavilyKey, settings.env.ANTHROPIC_API_KEY ?? "", settings.env.ANTHROPIC_AUTH_TOKEN ?? ""].filter(Boolean);
const redact = (s: string) => secrets.reduce((text, key) => text.split(key).join("[REDACTED]"), s);
const calls: { name: string; input: any }[] = [];
const outputs: string[] = [];
const sessions: string[] = [];
let initTools: string[] = []; let final = ""; let cost = 0;
const service = await startService(resolve("."), dir, { ...settings.env, TAVILY_API_KEY: tavilyKey }, async (prompt, options, onMessage, onQuery, inputId) => {
  assert.equal(options.env?.TAVILY_API_KEY, undefined);
  return runSession(prompt, { ...options, tools: ["Skill", "Read", "Bash"], maxTurns: 6, maxBudgetUsd: 0.4, maxThinkingTokens: 1024 }, message => {
    if (message.type === "system" && message.subtype === "init") { sessions.push(message.session_id); initTools = message.tools; }
    if (message.type === "assistant") for (const block of message.message.content) if (block.type === "tool_use") {
      calls.push({ name: block.name, input: block.input }); console.log(JSON.stringify({ tool: block.name }));
    }
    if (message.type === "user" && Array.isArray(message.message.content)) for (const block of message.message.content) if (block.type === "tool_result") outputs.push(redact(JSON.stringify(block.content)));
    if (message.type === "result") { cost += message.total_cost_usd; if (message.subtype === "success") final = message.result; }
    onMessage(message);
  }, onQuery, inputId);
});
try {
  const agent = service.store.execute({ kind: "user" }, { name: "agent.create", args: { name: "Tavily Probe", role: "仅执行一次联网搜索验证，不创建子 Agent。" }, requestId: "create" }) as Agent;
  service.store.execute({ kind: "user" }, { name: "direct.send", args: { agentId: agent.id, text: "测试联网搜索：请先实际调用 Skill 工具加载 raft:tavily-search，再使用 Bash 执行且仅执行一次 raftctl web search --query 'Claude Agent SDK TypeScript official documentation' --domains platform.claude.com --limit 3 --json。不要调用其他搜索工具，不读取任何凭据。不需要提取正文。根据命令实际返回的 results 简短报告两个来源 URL；如果出错，报告错误并停止，不重试。" }, requestId: "send" });
  const started = Date.now(); let lastProgress = 0;
  while (Date.now() - started < 90_000) {
    await new Promise(r => setTimeout(r, 250));
    for (const approval of service.scheduler.approvals.values()) approval.resolve(false);
    if (Date.now() - started > lastProgress + 20_000) { lastProgress = Date.now() - started; console.log(JSON.stringify({ elapsed: Math.round(lastProgress / 1000), tools: calls.map(c => c.name) })); }
    if (service.store.state.runs.length && !service.scheduler.active.size) break;
  }
  const checks = {
    skillLoaded: calls.some(c => c.name === "Skill" && c.input.skill === "raft:tavily-search"),
    searched: calls.filter(c => c.name === "Bash" && String(c.input.command).includes("raftctl web search")).length === 1,
    gotSources: outputs.some(s => s.includes('\\"provider\\":\\"tavily\\"') && s.includes("https://platform.claude.com/")),
    completed: service.store.state.runs[0]?.status === "done", noMcp: !initTools.some(t => t.startsWith("mcp__")),
  };
  const unfinished = service.scheduler.active.get(agent.id);
  if (unfinished) { service.scheduler.stop(agent.id); await unfinished.done; }
  // 独立验证 CLI 的正文提取分支，不再启动模型。
  service.store.transact(s => { s.agents[0]!.status = "running"; });
  service.scheduler.tokens.set("extract-probe", { kind: "agent", agentId: agent.id, runId: "extract-probe", channel: agent.id });
  service.scheduler.active.set(agent.id, { controller: new AbortController(), done: Promise.resolve() });
  const extracted = await sendControl({ name: "web.fetch", args: { url: "https://platform.claude.com/docs/en/agent-sdk/overview", maxChars: 1500 } }, { RAFT_SOCKET: service.socket, RAFT_RUN_TOKEN: "extract-probe" });
  service.scheduler.tokens.delete("extract-probe"); service.scheduler.active.delete(agent.id);
  const extraction = extracted.data as { results?: { content: string; truncated: boolean }[]; credits?: number } | undefined;
  const extractPassed = extracted.ok && !!extraction?.results?.[0]?.content;
  const report = { passed: Object.values(checks).every(Boolean) && extractPassed, checks, extractPassed, extracted, sessions, calls, outputs, final, sdkCostUsd: cost };
  const path = resolve(".raft/verification/tavily-live.json"); await mkdir(resolve(".raft/verification"), { recursive: true });
  await writeFile(path, redact(JSON.stringify(report, null, 2)) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ passed: report.passed, checks, extractPassed, extractCredits: extraction?.credits, final: redact(final), report: path }, null, 2));
  if (!report.passed) process.exitCode = 1;
} finally { await service.close(); await rm(dir, { recursive: true, force: true }); }
