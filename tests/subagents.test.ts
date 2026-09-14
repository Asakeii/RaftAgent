import { mkdtempSync, rmSync, statSync, readdirSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Store } from "../src/store.js";
import { controlCommand, sendControl } from "../src/control.js";
import { startService } from "../src/server.js";
import type { Agent, Actor, Room } from "../src/contracts.js";

function fixture(t: test.TestContext) {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "raft-store-test-"));
  const store = new Store(":memory:", workspaceRoot); t.after(() => { store.close(); rmSync(workspaceRoot, { recursive: true, force: true }); });
  const user: Actor = { kind: "user" };
  const exec = (name: string, args: Record<string, unknown>, actor: Actor = user, requestId: string = randomUUID()) => store.execute(actor, { name, args, requestId });
  const parent = exec("agent.create", { name: "parent", role: "planner" }) as Agent;
  const stranger = exec("agent.create", { name: "other", role: "other" }) as Agent;
  const actor: Actor = { kind: "agent", agentId: parent.id, runId: "parent-run", channel: parent.id };
  store.transact(s => { s.agents.find(a => a.id === parent.id)!.status = "running"; s.runs.push({ id: "parent-run", agentId: parent.id, inputId: "i", status: "running", at: "now" }); });
  return { store, exec, parent, stranger, actor };
}
test("子 Agent 创建绑定真实父身份，独立会话、系统提示词及初始任务原子保存，重复请求不重复创建", t => {
  const { store, exec, parent, actor } = fixture(t);
  const args = { name: "reviewer", systemPrompt: "检查边界\n保留证据", task: "阅读测试", parentAgentId: "spoof" };
  const child = exec("agent.create", args, actor, "create-1") as Agent;
  assert.equal(child.parentAgentId, parent.id); assert.equal(child.systemPrompt, args.systemPrompt); assert.notEqual(child.workspace, parent.workspace); assert.ok(statSync(child.workspace).isDirectory()); assert.equal(child.sessionId, undefined);
  assert.equal(store.state.inputs[0]!.replyToAgentId, parent.id); assert.equal(store.state.inputs[0]!.kind, "delegated");
  assert.deepEqual(exec("agent.create", args, actor, "create-1"), child);
  assert.equal(store.state.inputs.length, 1); assert.equal(store.state.agents.length, 3);
  assert.equal(readdirSync(store.workspaceRoot).length, 3);
  assert.throws(() => exec("agent.create", { ...args, name: "another" }, actor, "create-1"), /不同内容/);
});
test("不带任务创建空闲子 Agent，显式入群检查权限并推进版本", t => {
  const { store, exec, parent, stranger, actor } = fixture(t);
  const room = exec("room.create", { name: "共同空间", members: [parent.id] }) as Room;
  const other = exec("room.create", { name: "其他空间", members: [stranger.id] }) as Room;
  const child = exec("agent.create", { name: "helper", systemPrompt: "help", room: room.id }, actor) as Agent;
  assert.equal(child.status, "idle"); assert.equal(store.state.inputs.length, 0);
  assert.deepEqual(store.state.rooms[0]!.members, [parent.id, child.id]); assert.equal(store.state.rooms[0]!.version, 1);
  const count = store.state.agents.length;
  assert.throws(() => exec("agent.create", { name: "intruder", systemPrompt: "help", room: other.id }, actor), /权限/);
  assert.equal(store.state.agents.length, count);
});
test("只能查询/委派自己的直接子 Agent；停止状态不被委派绕过", t => {
  const { store, exec, parent, stranger, actor } = fixture(t);
  const child = exec("agent.create", { name: "child", systemPrompt: "help" }, actor) as Agent;
  assert.deepEqual((exec("agent.list", {}, actor) as Agent[]).map(a => a.id), [child.id]);
  assert.throws(() => exec("agent.status", { id: stranger.id }, actor), /不属于/);
  assert.throws(() => exec("agent.send", { id: stranger.id, task: "do it" }, actor), /不属于/);
  exec("agent.stop", { id: child.id });
  const result = exec("agent.send", { id: child.id, task: "下一步" }, actor) as { status: string };
  assert.equal(result.status, "queued"); assert.equal(store.state.agents.find(a => a.id === child.id)!.status, "stopped");
  assert.equal(store.state.inputs[0]!.replyToAgentId, parent.id);
});
test("创建子 Agent 使用现有总成员上限；无效任务不留下半个身份", t => {
  const { store, exec, actor } = fixture(t);
  assert.throws(() => exec("agent.create", { name: "bad", systemPrompt: "help", task: " " }, actor), /初始任务/);
  assert.equal(store.state.agents.length, 2);
  for (let i = 0; i < 10; i++) exec("agent.create", { name: `child-${i}`, systemPrompt: "help" }, actor);
  assert.throws(() => exec("agent.create", { name: "extra", systemPrompt: "help" }, actor), /12/);
});
test("CLI 解析名字、系统提示词文件与任务；拒绝多个 stdin 和文本/文件冲突", async () => {
  const result = await controlCommand(["agent", "create", "--name", "审查员", "--system-prompt-file", "-", "--task", "阅读代码", "--request-id", "c-1", "--json"], async () => "保留原文\n包括 ' 和 $()");
  assert.equal(result.name, "agent.create"); assert.equal(result.args.systemPrompt, "保留原文\n包括 ' 和 $()"); assert.equal(result.args.task, "阅读代码");
  await assert.rejects(controlCommand(["agent", "create", "--system-prompt-file", "-", "--task-file", "-"], async () => ""), /一个输入/);
  await assert.rejects(controlCommand(["agent", "create", "--system-prompt", "x", "--system-prompt-file", "-"], async () => ""), /不能同时/);
});
test("本地 CLI 创建后调度独立 SDK 配置，子任务结果只返回父 inbox，后续委派 resume 子会话", async t => {
  const dir = await mkdtemp(join(tmpdir(), "raft-child-"));
  const seen: { prompt: string; systemPrompt: unknown; resume: string | undefined }[] = [];
  const service = await startService(resolve("."), dir, { ANTHROPIC_API_KEY: "test" }, async (prompt, options, onMessage) => {
    assert.ok(statSync(options.cwd!).isDirectory());
    assert.ok(options.cwd!.startsWith(join(dir, "workspaces") + "/"));
    seen.push({ prompt, systemPrompt: options.systemPrompt, resume: options.resume });
    onMessage({ type: "system", subtype: "init", session_id: "child-session" } as SDKMessage);
    onMessage({ type: "result", subtype: "success", is_error: false, result: `完成：${prompt}` } as SDKMessage);
  });
  t.after(async () => { await service.close(); await rm(dir, { recursive: true, force: true }); });
  const parent = service.store.execute({ kind: "user" }, { name: "agent.create", args: { name: "parent", role: "planner" }, requestId: "p" }) as Agent;
  service.store.transact(s => { s.agents[0]!.status = "running"; s.runs.push({ id: "parent-run", agentId: parent.id, inputId: "p", status: "running", at: "now" }); });
  service.scheduler.tokens.set("parent-token", { kind: "agent", agentId: parent.id, runId: "parent-run", channel: parent.id });
  const env = { RAFT_SOCKET: service.socket, RAFT_RUN_TOKEN: "parent-token" };
  const response = await sendControl(await controlCommand(["agent", "create", "--name", "child", "--system-prompt", "UNIQUE_CHILD_PROMPT", "--task", "first-task", "--request-id", "child-create"], async () => ""), env);
  assert.equal(response.ok, true); const child = response.data as Agent;
  const wait = async (n: number) => { for (let i = 0; i < 100; i++) { if (service.store.state.receipts.filter(r => r.agentId === parent.id).length >= n) return; await new Promise(r => setTimeout(r, 10)); } throw new Error("子任务未完成"); };
  await wait(1);
  assert.match(String(seen[0]!.systemPrompt), /UNIQUE_CHILD_PROMPT/); assert.equal(seen[0]!.resume, undefined);
  assert.equal(service.store.state.agents.find(a => a.id === child.id)!.sessionId, "child-session");
  const resultMessage = service.store.state.messages.find(m => m.id.startsWith("delegation:"))!;
  assert.equal(resultMessage.channel, parent.id); assert.equal(resultMessage.sender, child.id); assert.match(resultMessage.text, /完成：first-task/);
  assert.equal(service.store.state.receipts[0]!.read, false);
  await sendControl({ name: "agent.send", args: { id: child.id, task: "followup" }, requestId: "send-2" }, env); await wait(2);
  assert.equal(seen[1]!.resume, "child-session"); assert.equal(seen[1]!.prompt, "followup");
  service.store.transact(s => { s.messages.push({ id: "private-child-message", channel: child.id, sender: child.id, text: "不应出现在父 Agent 查询中的私聊", mentions: [], at: "now" }); });
  const status = await sendControl({ name: "agent.status", args: { id: child.id } }, env);
  assert.equal((status.data as { results: unknown[] }).results.length, 2);
  assert.doesNotMatch(JSON.stringify(status.data), /不应出现在/);
});

test("子任务失败也返回父 inbox，停止的父 Agent 不会被结果恢复", async t => {
  const dir = await mkdtemp(join(tmpdir(), "raft-child-failure-"));
  const service = await startService(resolve("."), dir, { ANTHROPIC_API_KEY: "test" }, async () => { throw new Error("模型连接失败"); });
  t.after(async () => { await service.close(); await rm(dir, { recursive: true, force: true }); });
  const exec = (name: string, args: Record<string, unknown>, actor: Actor = { kind: "user" }) => service.store.execute(actor, { name, args, requestId: randomUUID() });
  const parent = exec("agent.create", { name: "parent", role: "planner" }) as Agent;
  service.store.transact(s => { s.agents[0]!.status = "running"; s.runs.push({ id: "p-run", agentId: parent.id, inputId: "p", status: "running", at: "now" }); });
  const child = exec("agent.create", { name: "child", systemPrompt: "help", task: "do it" }, { kind: "agent", agentId: parent.id, runId: "p-run", channel: parent.id }) as Agent;
  exec("agent.stop", { id: parent.id });
  for (let i = 0; i < 100 && !service.store.state.receipts.length; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(service.store.state.agents.find(a => a.id === child.id)!.status, "error");
  assert.equal(service.store.state.agents.find(a => a.id === parent.id)!.status, "stopped");
  const results = service.store.state.messages.filter(m => m.id.startsWith("delegation:"));
  assert.equal(results.length, 1); assert.match(results[0]!.text, /未完成：模型连接失败/);
  assert.equal(service.store.state.receipts[0]!.agentId, parent.id); assert.equal(service.store.state.receipts[0]!.read, false);
});
