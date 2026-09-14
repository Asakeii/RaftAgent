// 本地模拟模型响应，但使用真实 SDK 的 Write/Bash/Skill 和正在执行中的 reloadSkills。
// 无外部模型依赖；用于验证控制通道不会与当前 Bash 调用互相等待。
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { startService } from "../src/server.js";
import { runSession } from "../src/agent.js";
import type { Agent } from "../src/contracts.js";

const dir = await mkdtemp(join(tmpdir(), "raft-skills-react-"));
let steps: { name: string; input: Record<string, unknown> }[] = [];
let requests = 0; const results: string[] = [];
const loadedBodies = new Set<string>();
const provider = createServer(async (req, res) => {
  let body = ""; for await (const chunk of req) body += String(chunk);
  if (req.method !== "POST" || !req.url?.includes("/messages")) { res.setHeader("Content-Type", "application/json"); res.end("{}"); return; }
  if (req.url?.includes("count_tokens")) { res.end(JSON.stringify({ input_tokens: 100 })); return; }
  let payload;
  try { payload = JSON.parse(body); } catch { res.writeHead(400); res.end("Invalid JSON"); return; }
  if (!JSON.stringify(payload.messages).includes("SDK_REACT_HOT_SKILL_PROBE")) { res.writeHead(400); res.end("Unexpected test request"); return; }
  for (const message of payload.messages) if (message.role === "user" && Array.isArray(message.content)) {
    for (const block of message.content) if (block.type === "text") {
      if (String(block.text).includes("SKILL_BODY_WAS_LOADED")) loadedBodies.add("v1");
      if (String(block.text).includes("SKILL_BODY_V2_LOADED")) loadedBodies.add("v2");
    }
  }
  const step = steps[requests++];
  const id = `msg_${randomUUID()}`;
  const content = step ? { type: "tool_use", id: `tool_${requests}`, name: step.name, input: step.input } : { type: "text", text: "SDK_REACT_DONE" };
  const usage = { input_tokens: 100, output_tokens: 20 };
  const message = { id, type: "message", role: "assistant", model: payload.model, content: [content], stop_reason: step ? "tool_use" : "end_turn", stop_sequence: null, usage };
  if (!payload.stream) { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(message)); return; }
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  const event = (type: string, value: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
  event("message_start", { message: { ...message, content: [], stop_reason: null } });
  event("content_block_start", { index: 0, content_block: step ? { ...content, input: {} } : { type: "text", text: "" } });
  event("content_block_delta", { index: 0, delta: step ? { type: "input_json_delta", partial_json: JSON.stringify(step.input) } : { type: "text_delta", text: "SDK_REACT_DONE" } });
  event("content_block_stop", { index: 0 });
  event("message_delta", { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage });
  event("message_stop", {}); res.end();
});
await new Promise<void>(r => provider.listen(0, "127.0.0.1", r));
const port = (provider.address() as import("node:net").AddressInfo).port;
let queryCount = 0;
const sessions: string[] = [];
const service = await startService(resolve("."), dir, { ...process.env, ANTHROPIC_API_KEY: "test", ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_MODEL: "claude-sonnet-4-5", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" }, async (prompt, options, onMessage, onQuery, inputId) => {
  queryCount++;
  return runSession(prompt, { ...options, maxTurns: 16, canUseTool: async (_name, input) => ({ behavior: "allow", updatedInput: input }) }, message => {
    if (message.type === "system" && message.subtype === "init") sessions.push(message.session_id);
    if (message.type === "user" && Array.isArray(message.message.content)) for (const block of message.message.content) if (block.type === "tool_result") results.push(JSON.stringify(block));
    onMessage(message);
  }, onQuery, inputId);
});
try {
  const agent = service.store.execute({ kind: "user" }, { name: "agent.create", args: { name: "ReAct Probe", role: "本地协议实验" }, requestId: "create" }) as Agent;
  const draft = join(agent.workspace, "draft");
  const script = join(service.skills.prepare(agent.id), "skills", "echo-local", "scripts", "run.mjs");
  steps = [
    { name: "Write", input: { file_path: join(draft, "SKILL.md"), content: "---\nname: echo-local\ndescription: Test a live skill.\n---\nSKILL_BODY_WAS_LOADED\nRun the local scripts/run.mjs using Bash and report its output.\n" } },
    { name: "Write", input: { file_path: join(draft, "scripts", "run.mjs"), content: 'console.log("REACT_SCRIPT_RESULT_" + (17 + 25));\n' } },
    { name: "Bash", input: { command: "raftctl skill publish --source draft --request-id react-publish --json" } },
    { name: "Skill", input: { skill: "raft-local:echo-local" } },
    { name: "Bash", input: { command: `node '${script}'` } },
    { name: "Write", input: { file_path: join(draft, "SKILL.md"), content: "---\nname: echo-local\ndescription: Test updated live skill.\n---\nSKILL_BODY_V2_LOADED\nRun the updated local scripts/run.mjs using Bash.\n" } },
    { name: "Write", input: { file_path: join(draft, "scripts", "run.mjs"), content: 'console.log("REACT_SCRIPT_UPDATED_" + (20 + 23));\n' } },
    { name: "Bash", input: { command: "raftctl skill publish --source draft --request-id react-update --json" } },
    { name: "Skill", input: { skill: "raft-local:echo-local" } },
    { name: "Bash", input: { command: `node '${script}'` } },
  ];
  service.store.execute({ kind: "user" }, { name: "direct.send", args: { agentId: agent.id, text: "SDK_REACT_HOT_SKILL_PROBE" }, requestId: "run" });
  const start = Date.now();
  while (Date.now() - start < 45_000) {
    await new Promise(r => setTimeout(r, 100));
    if (service.store.state.runs.length && service.scheduler.active.size === 0) break;
  }
  assert.equal(service.store.state.runs[0]?.status, "done", JSON.stringify(service.store.state.agents));
  assert.equal(queryCount, 1); assert.equal(sessions.length, 1);
  assert.equal(requests, 11);
  assert.deepEqual([...loadedBodies].sort(), ["v1", "v2"]);
  assert.ok(results.some(r => r.includes('\\"status\\":\\"loaded\\"')), JSON.stringify(results));
  assert.ok(results.some(r => r.includes("REACT_SCRIPT_RESULT_42")), JSON.stringify(results));
  assert.ok(results.some(r => r.includes("REACT_SCRIPT_UPDATED_43")), JSON.stringify(results));
  assert.ok(!results.some(r => r.includes('"is_error":true')), JSON.stringify(results));
  const trace = service.traces.list(agent.id).runs[0]!;
  assert.equal(trace.status, "done"); assert.equal(trace.sessionId, sessions[0]);
  const traceEvents = service.traces.events(trace.id).events;
  assert.equal(traceEvents.filter(e => e.kind === "tool.start").length, 10);
  assert.equal(traceEvents.filter(e => e.kind === "tool.end").length, 10);
  assert.ok(traceEvents.some(e => e.kind === "model.response"));
  assert.ok(trace.turns && trace.usage);
  const history = await fetch(`http://127.0.0.1:${service.port}/api/agents/${agent.id}/history?limit=100`, { headers: { Authorization: `Bearer ${service.token}` } }).then(r => r.json());
  assert.ok(history.messages.some((m: { id: string; runId: string }) => m.id === trace.inputId && m.runId === trace.id));
  assert.ok(history.messages.filter((m: { role: string }) => m.role === "assistant" || m.role === "tool").every((m: { runId: string }) => m.runId === trace.id));
  assert.equal(history.messages.flatMap((m: { blocks: { kind: string }[] }) => m.blocks).filter((b: { kind: string }) => b.kind === "tool_result").length, 10);
  console.log("TRACE_SDK_OK: 真实 SDK 历史精确关联输入 Run，10 组工具往返，模型响应事件与用量均已采集。");
  console.log("SKILLS_REACT_OK: 本地模拟模型 + 真实 SDK；同一 Run 发布及更新、两次 Skill 正文加载、配套脚本输出 42/43");
} finally {
  await service.close(); await new Promise<void>(r => provider.close(() => r())); await rm(dir, { recursive: true, force: true });
}
