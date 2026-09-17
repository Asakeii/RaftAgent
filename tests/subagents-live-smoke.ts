// 显式运行：npm run smoke:subagents。使用 .env 的真实模型与临时数据目录。
import { config } from "dotenv";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { startService } from "../src/server.js";
import { runSession } from "../src/agent.js";
import type { Agent } from "../src/contracts.js";

config({ quiet: true });
if (!process.env.ANTHROPIC_API_KEY) throw new Error("缺少 ANTHROPIC_API_KEY；未执行真实 SDK 验证");
const dir = await mkdtemp(join(tmpdir(), "raft-subagents-live-"));
const runs: { resume: string | undefined; sessionId: string | undefined; childPrompt: boolean; tools: string[] }[] = [];
const service = await startService(resolve("."), join(dir, "data"), process.env, async (prompt, options, onMessage, onQuery) => {
  const run = { resume: options.resume, childPrompt: String(options.systemPrompt).includes("CHILD_SYSTEM_MARKER"), tools: [] as string[], sessionId: undefined as string | undefined };
  runs.push(run);
  return runSession(prompt, { ...options, maxTurns: 12, maxBudgetUsd: 0.6 }, message => {
    if (message.type === "system" && message.subtype === "init") run.sessionId = message.session_id;
    if (message.type === "assistant") for (const block of message.message.content) if (block.type === "tool_use") run.tools.push(block.name);
    onMessage(message);
  }, onQuery);
});
const command = (name: string, args: Record<string, unknown>) => service.store.execute({ kind: "user" }, { name, args, requestId: randomUUID() });
try {
  const parent = command("agent.create", { name: "Parent", role: "验证委派。只在首次用户输入创建一名子 Agent。收到子任务结果时读取 inbox 并确认已读，最终回复 PARENT_ACK。不要再创建成员，不要轮询或 sleep；没有结果时结束本轮等待通知。" }) as Agent;
  command("direct.send", { agentId: parent.id, text: "加载 raft:raft-collaboration Skill 并阅读创建子 Agent 的说明，通过 raftctl agent create 创建且仅创建一名名为 Calculator 的子 Agent。其 system-prompt 为：你是计算验证员。你的回答必须以 CHILD_SYSTEM_MARKER 开头，只计算收到的算式，不使用工具，不创建其他 Agent。初始 task 为：计算 17 + 25，回答数字结果。创建后结束本轮，等待自动返回。只用 Skill、Read 和 Bash raftctl，不使用其他命令。结果到达后读取 inbox，确认已读，然后回复 PARENT_ACK。" });
  const started = Date.now(); let announced = 0;
  while (Date.now() - started < 150_000) {
    await new Promise(r => setTimeout(r, 1000));
    for (const approval of service.scheduler.approvals.values()) {
      const input = approval.value.input as { command?: string };
      approval.resolve(approval.value.tool === "Bash" && !!input.command?.startsWith("raftctl ") && !/[;&|`$<>\n]/.test(input.command));
    }
    if (Date.now() - started > announced + 20_000) {
      announced = Date.now() - started;
      console.log(JSON.stringify({ elapsed: Math.round(announced / 1000), agents: service.store.state.agents.map(a => ({ name: a.name, status: a.status })) }));
    }
    if (service.store.state.agents.some(a => a.status === "error")) break;
    if (service.store.state.messages.some(m => m.sender === parent.id && m.text.includes("PARENT_ACK")) && service.scheduler.active.size === 0) break;
  }
  const children = service.store.state.agents.filter(a => a.parentAgentId === parent.id);
  const child = children[0];
  const result = service.store.state.messages.find(m => m.id.startsWith("delegation:") && m.sender === child?.id && m.channel === parent.id);
  const parentSession = service.store.state.sessions?.find(s => s.agentId === parent.id && s.channel === parent.id)?.sdkSessionId;
  const childSession = service.store.state.sessions?.find(s => s.agentId === child?.id && s.channel === child.id)?.sdkSessionId;
  const checks = {
    oneChild: children.length === 1 && child?.name === "Calculator",
    independentSessions: !!childSession && !!parentSession && childSession !== parentSession,
    customSystemPrompt: runs.some(r => r.sessionId === childSession && r.childPrompt),
    computedResult: !!result?.text.includes("CHILD_SYSTEM_MARKER") && /\b42\b/.test(result.text),
    resultAcknowledged: !!result && service.store.state.receipts.some(r => r.agentId === parent.id && r.messageId === result.id && r.read),
    parentFinished: service.store.state.messages.some(m => m.sender === parent.id && m.text.includes("PARENT_ACK")),
    noErrors: !service.store.state.agents.some(a => a.status === "error"),
  };
  const report = { dataDir: dir, checks, passed: Object.values(checks).every(Boolean), runs, agents: service.store.state.agents, messages: service.store.state.messages };
  await writeFile(join(dir, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ report: join(dir, "report.json"), checks, passed: report.passed, runs }, null, 2));
  if (!report.passed) process.exitCode = 1;
} finally { await service.close(); }
