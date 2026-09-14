import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Store } from "../src/store.js";
import type { Actor, Agent, Room, Draft } from "../src/contracts.js";

function setup(t: test.TestContext) {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "raft-store-test-"));
  const store = new Store(":memory:", workspaceRoot); t.after(() => { store.close(); rmSync(workspaceRoot, { recursive: true, force: true }); });
  const user: Actor = { kind: "user" };
  const command = (name: string, args: Record<string, unknown>, actor: Actor = user, requestId: string = randomUUID()) => store.execute(actor, { name, args, requestId });
  const a = command("agent.create", { name: "A", role: "实现" }) as Agent;
  const b = command("agent.create", { name: "B", role: "审查" }) as Agent;
  const room = command("room.create", { name: "demo", members: [a.id, b.id] }) as Room;
  const actor = (agentId: string): Actor => {
    const runId = randomUUID(); store.transact(s => { s.agents.find(a => a.id === agentId)!.status = "running"; s.runs.push({ id: runId, agentId, inputId: "test", status: "running", at: new Date().toISOString() }); });
    return { kind: "agent", agentId, runId, channel: room.id };
  };
  return { store, command, room, a, b, aa: actor(a.id), bb: actor(b.id) };
}
test("群消息只入接收者 inbox，读取不标读，精确确认不代表任务完成", t => {
  const { store, command, room, aa, bb, a, b } = setup(t);
  command("room.send", { room: room.id, body: "请审查", basedOn: 0 }, aa);
  const result = command("inbox.list", {}, bb) as { messages: { id: string }[] };
  assert.equal(result.messages.length, 1);
  assert.equal(store.state.receipts.some(r => r.agentId === a.id), false);
  assert.equal(store.state.receipts.find(r => r.agentId === b.id)!.read, false);
  command("inbox.ack", { ids: [result.messages[0]!.id] }, bb);
  assert.equal(store.state.receipts[0]!.read, true);
  assert.equal(store.state.tasks.length, 0);
});
test("过时草稿不会发布；重检仍可能 held，force 显式提交且不能二次提交", t => {
  const { store, command, room, aa } = setup(t);
  command("room.send", { room: room.id, body: "新要求" });
  const held = command("room.send", { room: room.id, basedOn: 0, body: "旧回复" }, aa) as { status: string; draftId: string };
  assert.equal(held.status, "held"); assert.equal(store.state.messages.length, 1);
  assert.equal((command("draft.resolve", { id: held.draftId, action: "retry", basedOn: 0 }, aa) as Draft).status, "held");
  command("draft.resolve", { id: held.draftId, action: "force" }, aa);
  assert.equal(store.state.messages.length, 2);
  assert.throws(() => command("draft.resolve", { id: held.draftId, action: "force" }, aa), /已处理/);
});
test("写命令幂等；同 ID 不同内容拒绝且不污染状态", t => {
  const { store, command, room, aa } = setup(t);
  const id = randomUUID(); const args = { room: room.id, basedOn: 0, body: "一次" };
  assert.deepEqual(command("room.send", args, aa, id), command("room.send", args, aa, id));
  assert.equal(store.state.messages.length, 1);
  assert.throws(() => command("room.send", { ...args, body: "两次" }, aa, id), /不同内容/);
  assert.equal(store.state.messages.length, 1);
});
test("任务仅一次领取，提交不自动完成，Agent 无用户完成权限", t => {
  const { command, room, aa, bb, a } = setup(t);
  const task = command("task.create", { room: room.id, title: "修复登录" }) as { id: string };
  command("task.claim", { id: task.id, expectedVersion: 0 }, aa);
  assert.throws(() => command("task.claim", { id: task.id, expectedVersion: 0 }, bb), /版本/);
  const submitted = command("task.submit", { id: task.id, expectedVersion: 1, evidence: "文件已修改，等待用户核验" }, aa) as { status: string; owner: string };
  assert.equal(submitted.owner, a.id); assert.equal(submitted.status, "reviewing");
  assert.throws(() => command("task.complete", { id: task.id, expectedVersion: 2 }, bb), /仅用户/);
  assert.equal((command("task.complete", { id: task.id, expectedVersion: 2 }) as { status: string }).status, "done");
});
test("活动不唤醒他人、不改变房间版本；过期 Run 命令被拒绝", t => {
  const { store, command, room, aa } = setup(t);
  command("activity.report", { text: "读取文件" }, aa);
  assert.equal(store.state.rooms.find(r => r.id === room.id)!.version, 0); assert.equal(store.state.receipts.length, 0);
  store.transact(s => { for (const r of s.runs) r.status = "done"; });
  assert.throws(() => command("activity.report", { text: "迟到" }, aa), /运行已结束/);
});
test("inbox 游标在确认已读后仍能继续分页", t => {
  const { command, room, aa, bb } = setup(t);
  for (let i = 0; i < 25; i++) command("room.send", { room: room.id, basedOn: i, body: `消息 ${i}` }, aa);
  const page = command("inbox.list", {}, bb) as { messages: { id: string }[]; nextCursor: string };
  command("inbox.ack", { ids: page.messages.map(m => m.id) }, bb);
  const next = command("inbox.list", { cursor: page.nextCursor }, bb) as { messages: { id: string }[] };
  assert.equal(next.messages.length, 5);
});
test("恢复不重放正在运行的输入，未知 Run 标记需要核验", t => {
  const { store, a } = setup(t);
  store.transact(s => { s.inputs.push({ id: "input", agentId: a.id, text: "写文件", channel: a.id, kind: "direct", status: "running" }); });
  store.recover();
  assert.equal(store.state.inputs[0]!.status, "unknown"); assert.equal(store.state.agents[0]!.status, "error");
  assert.equal(store.state.runs[0]!.status, "unknown");
});
test("Agent 无法访问未加入的房间或指定 Agent 工作目录", t => {
  const { command, a, bb } = setup(t);
  const privateRoom = command("room.create", { name: "另一个群", members: [a.id] }) as Room;
  assert.throws(() => command("room.changes", { room: privateRoom.id }, bb), /权限/);
  assert.throws(() => command("agent.create", { name: "伪造", workspace: "/other", role: "x" }, bb), /工作目录/);
});

test("用户批量添加群成员：原子校验、幂等、版本推进，只接收后续消息", t => {
  const { store, command, room, aa, a } = setup(t);
  const c = command("agent.create", { name: "C", role: "核验" }) as Agent;
  const d = command("agent.create", { name: "D", role: "实现" }) as Agent;
  command("room.send", { room: room.id, body: "加入前的消息" });
  const original = structuredClone(store.state);
  assert.throws(() => command("room.members.add", { room: room.id, members: [c.id] }, aa), /仅用户/);
  assert.throws(() => command("room.members.add", { room: room.id, members: [c.id, "missing"] }), /有效成员/);
  assert.throws(() => command("room.members.add", { room: room.id, members: [] }), /有效成员/);
  assert.throws(() => command("room.members.add", { room: "missing", members: [c.id] }), /房间/);
  assert.deepEqual(store.state, original);
  const args = { room: room.id, members: [a.id, c.id, c.id, d.id] }; const requestId = randomUUID();
  const result = command("room.members.add", args, { kind: "user" }, requestId) as { room: Room; added: string[] };
  assert.deepEqual(result.added, [c.id, d.id]); assert.equal(result.room.members.length, 4);
  assert.equal(result.room.version, original.rooms[0]!.version + 1);
  assert.deepEqual(command("room.members.add", args, { kind: "user" }, requestId), result);
  command("room.members.add", args);
  assert.equal(store.state.rooms[0]!.version, result.room.version);
  assert.deepEqual(store.state.inputs, original.inputs); assert.deepEqual(store.state.receipts, original.receipts);
  assert.deepEqual(store.state.agents, original.agents);
  const stale = command("room.send", { room: room.id, body: "旧成员快照", basedOn: original.rooms[0]!.version }, aa) as { status: string };
  assert.equal(stale.status, "held");
  command("room.send", { room: room.id, body: "加入后的消息", mentions: [c.id] });
  const received = store.state.receipts.filter(r => r.agentId === c.id);
  assert.equal(received.length, 1);
  assert.equal(store.state.messages.find(m => m.id === received[0]!.messageId)!.text, "加入后的消息");
});
