import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { HookCallback, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { Store } from '../src/store.js';
import { startService } from '../src/server.js';
import { contextSnapshot, nextSceneInput, sceneKey, sessionFor } from '../src/conversation-context.js';
import { controlCommand } from '../src/control.js';
import type { Actor, Agent, Message, Room } from '../src/contracts.js';

type Page = { messages: (Message & { truncated: boolean; offset: number; nextOffset: number | null })[]; nextCursor: string | null; snapshotSeq: number; total: number };
function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'raft-context-'));
  const store = new Store(':memory:', dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const exec = (name: string, args: Record<string, unknown> = {}, actor: Actor = { kind: 'user' }, requestId = randomUUID()) => store.execute(actor, { name, args, requestId });
  const a = exec('agent.create', { name: 'A', role: 'test' }) as Agent;
  const b = exec('agent.create', { name: 'B', role: 'test' }) as Agent;
  const room = exec('room.create', { name: '开发群', members: [a.id, b.id] }) as Room;
  const other = exec('room.create', { name: '产品群', members: [a.id] }) as Room;
  const hidden = exec('room.create', { name: '不可见群', members: [b.id] }) as Room;
  const actor: Actor = { kind: 'agent', agentId: a.id, runId: 'r', channel: room.id };
  store.transact(s => { s.agents[0]!.status = 'running'; s.runs.push({ id: 'r', agentId: a.id, inputId: 'i', channel: room.id, status: 'running', at: 'now' }); });
  return { dir, store, exec, a, b, room, other, hidden, actor };
}
const waitFor = async (predicate: () => boolean) => {
  for (let i = 0; i < 300; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('等待运行超时');
};

test('目录只有元信息；私聊和群内初始材料各自聚焦，未读 @ 是未读子集', t => {
  const { store, exec, a, room, other, actor } = fixture(t);
  exec('direct.send', { agentId: a.id, text: '最新私聊约束' });
  exec('room.send', { room: room.id, body: '本群请求', mentions: [a.id] });
  exec('room.send', { room: other.id, body: 'OTHER_BODY_SHOULD_NOT_APPEAR' });
  const directory = exec('room.list', {}, actor) as { rooms: { roomId: string; unreadCount: number; unreadMentionCount: number }[] };
  assert.equal(directory.rooms.length, 2);
  assert.equal(directory.rooms.find(r => r.roomId === room.id)!.unreadMentionCount, 1);
  assert.doesNotMatch(JSON.stringify(directory), /本群请求|OTHER_BODY/);
  const input = { id: 'i', agentId: a.id, channel: room.id, text: 'task', kind: 'room' as const, status: 'pending' as const };
  const group = JSON.stringify(contextSnapshot(store.state, a.id, input));
  assert.match(group, /最新私聊约束/); assert.match(group, /本群请求/); assert.doesNotMatch(group, /OTHER_BODY/);
  const direct = JSON.stringify(contextSnapshot(store.state, a.id, { ...input, channel: a.id }));
  assert.doesNotMatch(direct, /本群请求|OTHER_BODY/);
  assert.equal(store.state.receipts.filter(r => r.read).length, 0);
});

test('中文短词检索、AND/OR、发送者和权限过滤；读取是只读，不自动 ack', t => {
  const { store, exec, a, b, room, other, hidden, actor } = fixture(t);
  exec('room.send', { room: room.id, body: '登录接口发生超时，需要重试', mentions: [a.id] });
  exec('room.send', { room: other.id, body: '接口已上线' });
  const secret = exec('room.send', { room: hidden.id, body: '超时 secret' }) as { message: Message };
  exec('direct.send', { agentId: a.id, text: '我的私聊 超时' });
  exec('direct.send', { agentId: b.id, text: '他人私聊 超时' });
  const before = JSON.stringify(store.state); let changes = 0; store.changed = () => { changes++; };
  const find = (args: Record<string, unknown>) => exec('message.search', args, actor) as Page;
  assert.equal(find({ query: '超时', room: room.id }).messages.length, 1);
  assert.equal(find({ query: '接口 超时', scope: 'joined' }).messages.length, 1);
  assert.equal(find({ query: '接口 超时', scope: 'joined', match: 'any' }).messages.length, 2);
  assert.equal(find({ query: '超时', scope: 'private' }).messages[0]!.text, '我的私聊 超时');
  assert.equal(find({ query: '超时', sender: b.id }).messages.length, 0);
  assert.equal(find({ query: '超时', unread: true, mentioned: true }).messages.length, 1);
  assert.throws(() => find({ query: '超时', room: hidden.id }), /权限/);
  assert.throws(() => exec('message.context', { id: secret.message.id }, actor), /权限/);
  assert.throws(() => find({ query: '超时', scope: b.id }), /scope/);
  assert.equal(JSON.stringify(store.state), before); assert.equal(changes, 0);
});

test('分页固定截止序号和过滤条件，确认/新消息不会造成重复、漏页或混入', t => {
  const { exec, room, actor } = fixture(t);
  for (let i = 0; i < 5; i++) exec('room.send', { room: room.id, body: `条目 ${i}` });
  const args = { room: room.id, unread: true, limit: 2 };
  const first = exec('message.list', args, actor) as Page;
  exec('inbox.ack', { ids: first.messages.map(m => m.id) }, actor);
  exec('room.send', { room: room.id, body: '后来消息' });
  const second = exec('message.list', { ...args, cursor: first.nextCursor }, actor) as Page;
  const last = exec('message.list', { ...args, cursor: second.nextCursor }, actor) as Page;
  const all = [...first.messages, ...second.messages, ...last.messages];
  assert.deepEqual(all.map(m => m.text), ['条目 0', '条目 1', '条目 2', '条目 3', '条目 4']);
  assert.equal(new Set(all.map(m => m.id)).size, 5); assert.equal(last.nextCursor, null);
  assert.equal(second.snapshotSeq, first.snapshotSeq);
  assert.throws(() => exec('message.list', { ...args, mentioned: true, cursor: first.nextCursor }, actor), /条件已变化/);
  assert.throws(() => exec('message.list', { ...args, cursor: 'broken' }, actor), /游标/);
});

test('长消息片段明确截断，可分段重建；邻近消息不会越群', t => {
  const { exec, room, other, actor } = fixture(t);
  const text = '甲'.repeat(9000) + '定位词' + '乙'.repeat(16000);
  exec('room.send', { room: other.id, body: '邻群' });
  const result = exec('room.send', { room: room.id, body: text }) as { message: Message };
  const search = exec('message.search', { query: '定位词' }, actor) as Page;
  assert.match(search.messages[0]!.text, /定位词/); assert.equal(search.messages[0]!.truncated, true);
  let offset: number | null = 0; let restored = '';
  do {
    const page = exec('message.get', { id: result.message.id, offset }, actor) as { message: Page['messages'][number] };
    restored += page.message.text; offset = page.message.nextOffset;
  } while (offset !== null);
  assert.equal(restored, text);
  const nearby = exec('message.context', { id: result.message.id }, actor) as Page;
  assert.equal(nearby.messages.length, 1); assert.equal(nearby.messages[0]!.truncated, true);
});

test('多个群的唤醒和 ack 分开；本场景 inbox 不读取另一个群', t => {
  const { store, exec, a, room, other, actor } = fixture(t);
  exec('room.send', { room: other.id, body: '普通消息' });
  exec('room.send', { room: room.id, body: '需要优先', mentions: [a.id] });
  const first = nextSceneInput(store.state, a.id)!;
  assert.equal(first.channel, room.id);
  store.transact(s => { s.sceneNotices![sceneKey(a.id, first.channel)] = first.noticeThrough!; });
  const second = nextSceneInput(store.state, a.id)!;
  assert.equal(second.channel, other.id);
  assert.equal((exec('inbox.list', {}, actor) as Page).messages[0]!.text, '需要优先');
  exec('inbox.ack', { ids: second.messageIds }, actor);
  assert.equal(nextSceneInput(store.state, a.id)!.channel, other.id, '其它场景 ack 不能吞掉该场景唤醒');
  store.transact(s => { s.sceneNotices![sceneKey(a.id, other.id)] = second.noticeThrough!; });
  assert.equal(nextSceneInput(store.state, a.id), undefined);
});

test('群委派结果只属于发起场景和接收 Agent，不成为公开消息', t => {
  const { store, exec, a, b, room, actor } = fixture(t);
  const child = exec('agent.create', { name: 'child', role: 'help', task: '处理', room: room.id }, actor) as Agent;
  const input = store.state.inputs.find(i => i.agentId === child.id)!;
  assert.equal(input.returnChannel, room.id);
  store.transact(s => store.delegationResult(s, input, 'child-run', '内部产物'));
  const message = store.state.messages.find(m => m.id === 'delegation:child-run')!;
  assert.equal(message.channel, room.id); assert.equal(message.internalFor, a.id);
  assert.equal(store.state.messages.filter(m => m.channel === a.id).length, 0);
  assert.doesNotMatch(JSON.stringify(exec('room.changes', { room: room.id }, actor)), /内部产物/);
  assert.match(JSON.stringify(exec('inbox.list', {}, actor)), /内部产物/);
  store.transact(s => { s.agents.find(x => x.id === b.id)!.status = 'running'; s.runs.push({ id: 'br', agentId: b.id, inputId: 'bi', status: 'running', at: 'now' }); });
  assert.throws(() => exec('message.get', { id: message.id }, { kind: 'agent', agentId: b.id, runId: 'br', channel: room.id }), /权限/);
});

test('新成员的历史数不等于未读数，背景更新带新版本并保留缺口', t => {
  const { store, exec, a, b, other, actor } = fixture(t);
  exec('room.send', { room: other.id, body: '入群前历史' });
  exec('room.members.add', { room: other.id, members: [b.id] });
  store.transact(s => { s.agents.find(x => x.id === b.id)!.status = 'running'; s.runs.push({ id: 'br', agentId: b.id, inputId: 'bi', status: 'running', at: 'now' }); });
  const card = exec('room.inspect', { room: other.id }, { ...actor, agentId: b.id, runId: 'br' }) as { messageCount: number; unreadCount: number };
  assert.equal(card.messageCount, 1); assert.equal(card.unreadCount, 0);
  for (let i = 0; i < 15; i++) exec('direct.send', { agentId: a.id, text: `要求 ${i}` });
  const input = { id: 'i', agentId: a.id, channel: other.id, text: '', kind: 'room' as const, status: 'pending' as const };
  const before = contextSnapshot(store.state, a.id, input).privateBackground!;
  assert.equal(before.incomplete, true); assert.equal(before.omittedMessageCount, 3);
  exec('direct.send', { agentId: a.id, text: '最新更正' });
  const after = contextSnapshot(store.state, a.id, input).privateBackground!;
  assert.ok(after.version > before.version); assert.equal(after.entries.at(-1)!.text, '最新更正');
});

test('CLI 支持布尔过滤和游标，拒绝缺失值与重复参数', async () => {
  const result = await controlCommand(['message', 'search', '--room', 'r', '--query', '接口 超时', '--unread', '--mentioned', '--limit', '5', '--json'], async () => '');
  assert.deepEqual(result.args, { room: 'r', query: '接口 超时', unread: true, mentioned: true, limit: 5 });
  await assert.rejects(controlCommand(['message', 'search', '--query', '--limit', '5'], async () => ''), /缺少值/);
  await assert.rejects(controlCommand(['message', 'list', '--unread', '--unread'], async () => ''), /重复/);
});

test('停止后恢复群待办，不生成多余私聊输入；停止身份不能继续检索', t => {
  const { store, exec, a, room, actor } = fixture(t);
  exec('agent.stop', { id: a.id });
  exec('room.send', { room: room.id, body: '等待恢复的群任务' });
  assert.throws(() => exec('message.search', { query: '任务' }, actor), /停止/);
  store.transact(s => { s.runs[0]!.status = 'done'; });
  exec('agent.resume', { id: a.id });
  assert.equal(store.state.inputs.length, 0, '已有群待办时不得生成私聊恢复输入');
  assert.equal(nextSceneInput(store.state, a.id)!.channel, room.id);
});

test('运行中的新群消息只刷新私聊目录，不吞掉任何群的后续唤醒', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'raft-context-refresh-'));
  let a: Agent, room: Room, other: Room;
  let refreshed = '', calls = 0;
  const service = await startService(resolve('.'), dir, { ANTHROPIC_API_KEY: 'test' }, async (prompt, options, emit) => {
    calls++;
    if (prompt === 'work') {
      exec('room.send', { room: room.id, body: 'FIRST_GROUP_SECRET' });
      exec('room.send', { room: other.id, body: 'SECOND_GROUP_SECRET' });
      const hook = options.hooks!.PostToolBatch![0]!.hooks[0]!;
      refreshed = JSON.stringify(await hook({ hook_event_name: 'PostToolBatch' } as Parameters<HookCallback>[0], undefined, { signal: options.abortController!.signal }));
      assert.deepEqual(service.store.state.sceneNotices, {});
    }
    emit({ type: 'result', subtype: 'success', result: 'done', is_error: false } as SDKMessage);
  });
  t.after(async () => { await service.close(); rmSync(dir, { recursive: true, force: true }); });
  const exec = (name: string, args: Record<string, unknown>) => service.store.execute({ kind: 'user' }, { name, args, requestId: randomUUID() });
  a = exec('agent.create', { name: 'A', role: 'test' }) as Agent;
  room = exec('room.create', { name: 'R', members: [a.id] }) as Room;
  other = exec('room.create', { name: 'S', members: [a.id] }) as Room;
  exec('direct.send', { agentId: a.id, text: 'work' });
  await waitFor(() => calls === 3 && !service.scheduler.active.size);
  assert.match(refreshed, /unreadCount/); assert.doesNotMatch(refreshed, /FIRST_GROUP_SECRET|SECOND_GROUP_SECRET/);
  assert.deepEqual(service.store.state.runs.map(r => r.channel), [a.id, room.id, other.id]);
});

test('运行时各场景独立 resume，群输出不写私聊，历史与日志 API 按场景隔离', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'raft-scene-runtime-'));
  const seen: { channel: string; resume: string | undefined; context: string }[] = [];
  let serial = 0;
  const service = await startService(resolve('.'), dir, { ANTHROPIC_API_KEY: 'test' }, async (_prompt, options, emit) => {
    const hook = options.hooks!.UserPromptSubmit![0]!.hooks[0]!;
    const context = JSON.stringify(await hook({ hook_event_name: 'UserPromptSubmit' } as Parameters<HookCallback>[0], undefined, { signal: options.abortController!.signal }));
    const actor = service.scheduler.tokens.get(options.env!.RAFT_RUN_TOKEN!)!;
    assert.equal(actor.kind, 'agent'); if (actor.kind !== 'agent') throw new Error();
    const sid = options.resume ?? `scene-${++serial}`;
    seen.push({ channel: actor.channel, resume: options.resume, context });
    assert.equal(options.settings && typeof options.settings === 'object' && options.settings.autoMemoryEnabled, false);
    emit({ type: 'system', subtype: 'init', session_id: sid } as SDKMessage);
    emit({ type: 'assistant', uuid: randomUUID(), message: { content: [{ type: 'text', text: `output:${actor.channel}` }] } } as SDKMessage);
    emit({ type: 'result', subtype: 'success', result: 'done', is_error: false } as SDKMessage);
  }, async sessionId => [{ type: 'user', uuid: 'row', message: { role: 'user', content: sessionId }, session_id: sessionId, parent_tool_use_id: null, parent_agent_id: null }]);
  t.after(async () => { await service.close(); rmSync(dir, { recursive: true, force: true }); });
  const exec = (name: string, args: Record<string, unknown>) => service.store.execute({ kind: 'user' }, { name, args, requestId: randomUUID() });
  const a = exec('agent.create', { name: 'A', role: 'test' }) as Agent;
  const room = exec('room.create', { name: 'R', members: [a.id] }) as Room;
  const other = exec('room.create', { name: 'S', members: [a.id] }) as Room;
  const send = async (name: string, args: Record<string, unknown>, n: number) => { exec(name, args); await waitFor(() => seen.length === n && !service.scheduler.active.size); };
  await send('direct.send', { agentId: a.id, text: 'private constraint' }, 1);
  const privateCount = service.store.state.messages.filter(m => m.channel === a.id).length;
  await send('room.send', { room: room.id, body: 'group marker', mentions: [a.id] }, 2);
  await send('room.send', { room: other.id, body: 'other marker' }, 3);
  assert.equal(service.store.state.messages.filter(m => m.channel === a.id).length, privateCount);
  await send('room.send', { room: room.id, body: 'again' }, 4);
  await send('direct.send', { agentId: a.id, text: 'continue private' }, 5);
  assert.deepEqual(seen.map(x => x.resume), [undefined, undefined, undefined, 'scene-2', 'scene-1']);
  assert.doesNotMatch(seen[4]!.context, /group marker|other marker/);
  assert.match(seen[1]!.context, /private constraint/);
  assert.equal(sessionFor(service.store.state, a.id, room.id), 'scene-2');
  const base = `http://127.0.0.1:${service.port}/api/agents/${a.id}`;
  const headers = { Authorization: `Bearer ${service.token}` };
  const history = await fetch(`${base}/history`, { headers }).then(r => r.json());
  assert.deepEqual(history.sessions, ['scene-1']);
  assert.equal((await fetch(`${base}/history?sessionId=scene-2`, { headers })).status, 400);
  const groupHistory = await fetch(`${base}/history?conversationId=${room.id}`, { headers }).then(r => r.json());
  assert.deepEqual(groupHistory.sessions, ['scene-2']);
  const logs = await fetch(`${base}/traces?conversationId=${room.id}`, { headers }).then(r => r.json());
  assert.equal(logs.runs.length, 2);
  assert.equal((await fetch(`${base}/traces/${logs.runs[0].id}`, { headers })).status, 404);
});

test('旧混合 session 归档、新会话映射和通知位置在重启后保留', t => {
  const dir = mkdtempSync(join(tmpdir(), 'raft-context-migrate-')); const path = join(dir, 'state.sqlite');
  let store = new Store(path, dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const a = store.execute({ kind: 'user' }, { name: 'agent.create', args: { name: 'old', role: 'test' }, requestId: 'a' }) as Agent;
  store.transact(s => { delete s.contextVersion; s.agents[0]!.sessionId = 'mixed-old'; s.notices[a.id] = 20; s.messages.push({ id: 'old', channel: a.id, sender: a.id, text: '旧混合内容', mentions: [], at: 'now' }); });
  store.close(); store = new Store(path, dir);
  assert.equal(store.state.agents[0]!.sessionId, 'mixed-old'); assert.equal(sessionFor(store.state, a.id, a.id), undefined);
  assert.equal(store.state.messages[0]!.legacyContext, true);
  assert.equal(store.state.sceneNotices![sceneKey(a.id, a.id)], 20);
  store.transact(s => { s.sessions!.push({ agentId: a.id, channel: a.id, sdkSessionId: 'new' }); });
  store.close(); store = new Store(path, dir);
  assert.equal(sessionFor(store.state, a.id, a.id), 'new');
  assert.ok(store.state.messages[0]!.seq);
});

test('宿主时间明确本地日期、时区与旧日程解释规则', t => {
  const { store, a, room } = fixture(t);
  const now = new Date('2026-09-17T17:48:00Z');
  const snapshot = contextSnapshot(store.state, a.id, { id: 'clock', agentId: a.id, channel: room.id, kind: 'inbox', text: '', status: 'pending' }, false, now);
  assert.equal(snapshot.asOf, now.toISOString());
  assert.equal(snapshot.clock.localTime, now.toLocaleString('sv-SE'));
  assert.ok(snapshot.clock.timeZone);
  assert.match(snapshot.clock.policy, /原消息日期/);
  assert.equal(snapshot.currentRoom!.inbox.status, 'none');
});
