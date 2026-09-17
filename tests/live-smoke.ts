// 显式运行：npm run smoke:live。使用 .env 的真实模型，可能产生少量 API 费用。
import { config } from "dotenv";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { startService } from "../src/server.js";
import { runSession } from "../src/agent.js";
import type { Agent, Room } from "../src/contracts.js";
config({ quiet: true });
if (!process.env.ANTHROPIC_API_KEY) throw new Error("缺少 ANTHROPIC_API_KEY；未执行真实 SDK 验证");
const dir = await mkdtemp(join(tmpdir(), "raft-live-"));
const init: unknown[] = []; const tools: string[] = [];
const service = await startService(resolve("."), join(dir, "data"), process.env, async (prompt, options, onMessage, onQuery) => runSession(prompt, { ...options, maxTurns: 12, maxBudgetUsd: 0.6 }, message => {
  if (message.type === "system" && message.subtype === "init") init.push({ tools: message.tools, skills: message.skills, sessionId: message.session_id });
  if (message.type === "assistant") for (const block of message.message.content) if (block.type === "tool_use") tools.push(block.name);
  onMessage(message);
}, onQuery));
const command = (name: string, args: Record<string, unknown>) => service.store.execute({ kind: "user" }, { name, args, requestId: randomUUID() });
try {
  const a = command("agent.create", { name: "Atlas", role: "验证发送者；收到 SMOKE_ACK 后只确认已读，不再发任何消息。" }) as Agent;
  const b = command("agent.create", { name: "Sage", role: "验证接收者。收到 SMOKE_PING 时用 raftctl 确认已读，向同一群发送且仅发送一次 SMOKE_ACK。其他情况保持沉默。" }) as Agent;
  const room = command("room.create", { name: "真实协作验证", members: [a.id, b.id] }) as Room;
  command("direct.send", { agentId: a.id, text: `加载 raft:raft-collaboration Skill，用 Bash 调用 raftctl 向群 ${room.id} 发送 SMOKE_PING。读取当前房间版本后发送，一次即可。不需要读取文件，不要调用其他 shell 命令。` });
  const start = Date.now(); let announced = 0;
  while (Date.now() - start < 150_000) {
    await new Promise(r => setTimeout(r, 1000));
    // 此脚本只批准验证目录下的 raftctl 直接调用；不会批准任意 shell。
    for (const approval of service.scheduler.approvals.values()) {
      const input = approval.value.input as { command?: string };
      if (approval.value.tool === "Bash" && input.command?.startsWith("raftctl ") && !/[;&|`$<>\n]/.test(input.command)) approval.resolve(true);
      else approval.resolve(false);
    }
    if (Date.now() - start > announced + 20_000) { announced = Date.now() - start; console.log(JSON.stringify({ elapsed: Math.round(announced / 1000), statuses: service.store.state.agents.map(x => ({ name: x.name, status: x.status })), tools })); }
    if (service.store.state.agents.some(x => x.status === "error")) break;
    if (service.store.state.messages.some(m => m.channel === room.id && m.sender === b.id && m.text.includes("SMOKE_ACK")) && service.scheduler.active.size === 0) break;
  }
  const report = { dataDir: dir, init, tools, agents: service.store.state.agents.map(x => ({ name: x.name, status: x.status, sessions: service.store.state.sessions?.filter(s => s.agentId === x.id), error: x.error })), messages: service.store.state.messages.map(m => ({ channel: m.channel === room.id ? "room" : "direct", sender: m.sender, text: m.text })), passed: service.store.state.messages.some(m => m.channel === room.id && m.sender === b.id && m.text.includes("SMOKE_ACK")) };
  await writeFile(join(dir, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
} finally { await service.close(); }
