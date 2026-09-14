// 使用真实模型验证同一 Run 自编写 → 发布 → Skill 调用 → 本地脚本执行。
import { config } from "dotenv";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { startService } from "../src/server.js";
import { runSession } from "../src/agent.js";
import type { Agent } from "../src/contracts.js";

config({ quiet: true });
if (!process.env.ANTHROPIC_API_KEY) throw new Error("缺少 API Key，未运行真实 Skill 验证");
const dir = await mkdtemp(join(tmpdir(), "raft-skills-live-"));
const tools: { name: string; input: Record<string, unknown> }[] = [];
const sessions: string[] = []; const outputs: string[] = [];
let queryCount = 0;
const service = await startService(resolve("."), dir, process.env, async (prompt, options, onMessage, onQuery) => {
  queryCount++;
  return runSession(prompt, { ...options, maxTurns: 16, maxBudgetUsd: 0.8, maxThinkingTokens: 1024 }, message => {
    if (message.type === "system" && message.subtype === "init") sessions.push(message.session_id);
    if (message.type === "assistant") for (const block of message.message.content) if (block.type === "tool_use") tools.push({ name: block.name, input: block.input as Record<string, unknown> });
    if (message.type === "user" && Array.isArray(message.message.content)) for (const block of message.message.content) if (block.type === "tool_result") outputs.push(JSON.stringify(block.content));
    onMessage(message);
  }, onQuery);
});
try {
  const agent = service.store.execute({ kind: "user" }, { name: "agent.create", args: { name: "Skill Builder", role: "执行一个本地 Skill 热加载实验，不创建子 Agent。所有编写、发布、加载和调用都在当前轮完成。" }, requestId: randomUUID() }) as Agent;
  service.store.execute({ kind: "user" }, { name: "direct.send", args: { agentId: agent.id, text: "请在这一轮完成：加载 raft:raft-collaboration 并阅读 Skill 发布说明。用 Write 在 skill-drafts/math-helper/ 创建 SKILL.md 与 scripts/add.mjs。Skill 名字 math-helper，描述说明它用于通过本地脚本做加法；正文指示调用 Bash 执行 node '<Skill base directory>/scripts/add.mjs' 17 25。脚本从命令行读取两个数字，输出 HOT_SKILL_OK_ 加上它们的和。完成编写后通过 raftctl skill publish 发布，核验 active=true 和 refresh.status=loaded。随后必须实际调用原生 Skill 工具 raft-local:math-helper，再按它的说明执行已发布目录里的脚本，报告实际输出。不要只读取 SKILL.md 冒充 Skill 调用，不要结束本轮等待下一轮，不要创建其他成员。只使用 Read、Skill、Write 和必要的 Bash raftctl/node 命令。" }, requestId: randomUUID() });
  const started = Date.now(); let announced = 0;
  while (Date.now() - started < 150_000) {
    await new Promise(r => setTimeout(r, 500));
    for (const approval of service.scheduler.approvals.values()) {
      const input = approval.value.input as { command?: string; file_path?: string };
      const command = input.command ?? "";
      const safeCommand = !/[;&|`$<>\n]/.test(command) && (command.startsWith("raftctl ") || (command.startsWith("node ") && command.includes(join(dir, "skills", agent.id)) && command.includes("/scripts/add.mjs")));
      const safeWrite = approval.value.tool === "Write" && typeof input.file_path === "string" && resolve(input.file_path).startsWith(join(agent.workspace, "skill-drafts") + "/");
      approval.resolve(safeWrite || (approval.value.tool === "Bash" && safeCommand));
    }
    if (Date.now() - started > announced + 20_000) {
      announced = Date.now() - started;
      console.log(JSON.stringify({ elapsed: Math.round(announced / 1000), status: service.store.state.agents[0]?.status, tools: tools.map(t => t.name), published: service.store.state.publishedSkills?.length ?? 0 }));
    }
    if (service.store.state.runs.length && service.scheduler.active.size === 0) break;
  }
  const skill = service.store.state.publishedSkills?.find(s => s.agentId === agent.id && s.name === "math-helper");
  const checks = {
    oneQuery: queryCount === 1 && sessions.length === 1,
    wroteSkill: tools.some(t => t.name === "Write" && String(t.input.file_path).endsWith("/SKILL.md")),
    published: !!skill,
    skillInvoked: tools.some(t => t.name === "Skill" && t.input.skill === "raft-local:math-helper"),
    scriptInvoked: !!skill && tools.some(t => t.name === "Bash" && String(t.input.command).includes("/scripts/add.mjs") && (String(t.input.command).includes(skill.version) || String(t.input.command).includes("/plugin/skills/math-helper/"))),
    actualOutput: outputs.some(output => output.includes("HOT_SKILL_OK_42")),
    noError: service.store.state.runs.length === 1 && service.store.state.runs[0]?.status === "done",
  };
  const report = { passed: Object.values(checks).every(Boolean), checks, queryCount, sessions, tools, outputs, messages: service.store.state.messages, agents: service.store.state.agents };
  const path = join(dir, "report.json"); await writeFile(path, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, checks, report: path, sessions }, null, 2));
  if (!report.passed) process.exitCode = 1;
} finally { await service.close(); }
