import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SDKMessage, Query } from '@anthropic-ai/claude-agent-sdk';
import type { Agent, Room, Snapshot } from '../src/contracts.js';
import { startService } from '../src/server.js';
import { nextSceneInput } from '../src/conversation-context.js';
import type { SessionRunner } from '../src/runtime.js';
const until = async (check: () => boolean) => { for (let i = 0; i < 300; i++) { if (check()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('condition timed out'); };
async function fixture(t: TestContext, runner: SessionRunner) {
  const dir = await mkdtemp(join(tmpdir(), 'raft-chat-runtime-'));
  const service = await startService(resolve('.'), dir, { ANTHROPIC_API_KEY: 'test' }, runner);
  t.after(async () => { await service.close(); await rm(dir, { recursive: true, force: true }); });
  const exec = (name: string, args: Record<string, unknown>) => service.store.execute({ kind: 'user' }, { name, args, requestId: randomUUID() });
  const headers = { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' };
  const base = `http://127.0.0.1:${service.port}/api/`;
  const post = async (name: string, args: Record<string, unknown>, requestId: string = randomUUID()) => {
    const response = await fetch(base + 'command', { method: 'POST', headers, body: JSON.stringify({ name, args, requestId }) });
    assert.equal(response.status, 200); return response.json();
  };
  return { service, exec, post, snapshot: async (): Promise<Snapshot> => fetch(base + 'state', { headers }).then(r => r.json()) };
}
test('发消息唤起停止/出错的 Agent，流式快照隔离、停止半段保留、再次发送和旧停止重试安全', async t => {
  let release: (() => void) | undefined, calls = 0, interrupts = 0;
  const { service, exec, post, snapshot } = await fixture(t, async (_prompt, options, emit, onQuery) => {
    calls++;
    onQuery({ interrupt: async () => { interrupts++; } } as unknown as Query);
    emit({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: `api-${calls}` } } } as SDKMessage);
    emit({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '正在输出' } } } as SDKMessage);
    await new Promise<void>(r => { release = r; options.abortController!.signal.addEventListener('abort', () => { setTimeout(r, 500); }, { once: true }); });
    if (options.abortController!.signal.aborted) throw new Error('aborted');
  });
  const a = exec('agent.create', { name: 'A', role: 'test' }) as Agent;
  exec('agent.stop', { id: a.id });
  await post('direct.send', { agentId: a.id, text: '开始' });
  await until(() => calls === 1);
  const state = await snapshot(); assert.equal(state.streamingMessages![0]!.text, '正在输出');
  assert.equal(state.streamingMessages![0]!.channel, a.id);
  assert.equal(state.state.messages.filter(m => m.sender === a.id).length, 0);
  const runIds = state.state.runs.filter(r => r.status === 'running').map(r => r.id);
  await post('conversation.stop', { channel: a.id, runIds }, 'stop-once');
  assert.equal(interrupts, 1);
  // New input while the interrupted SDK is still shutting down must survive its catch/finally.
  await post('direct.send', { agentId: a.id, text: '再来一次' });
  await post('conversation.stop', { channel: a.id, runIds }, 'stop-once');
  release!(); await until(() => calls === 2);
  assert.equal(service.store.state.messages.find(m => m.delivery === 'interrupted')!.text, '正在输出');
  await post('conversation.stop', { channel: a.id, runIds }, 'stop-once');
  assert.equal(interrupts, 1, '重试旧停止不能终止新一轮');
  const current = service.store.state.runs.filter(r => r.status === 'running').map(r => r.id);
  await post('conversation.stop', { channel: a.id, runIds: current }); release!();
  await until(() => !service.scheduler.active.size);
  assert.equal(service.scheduler.streamingMessages.size, 0);
});

test('群聊显式发送版本竞争保留过时草稿，静默工具结束不发布；群停止不打断其他场景', async t => {
  const pending = new Map<string, () => void>();
  const { service, exec, post } = await fixture(t, async (prompt, options, emit) => {
    const actor = service.scheduler.tokens.get(options.env!.RAFT_RUN_TOKEN!)!;
    assert.equal(actor.kind, 'agent'); if (actor.kind !== 'agent') return;
    const run = service.store.state.runs.find(r => r.agentId === actor.agentId && r.status === 'running')!;
    const input = service.store.state.inputs.find(i => i.id === run.inputId)!;
    const basedOn = service.store.state.rooms.find(r => r.id === actor.channel)?.version;
    // A member reads the shared update and deliberately stays silent without new work.
    if (input.messageIds?.length && input.messageIds.every(id => service.store.state.messages.find(m => m.id === id)?.sender !== 'user')) {
      service.store.execute(actor, { name: 'room.silence', args: {}, requestId: randomUUID() });
      return;
    }
    await new Promise<void>(r => { pending.set(actor.agentId, r); options.abortController!.signal.addEventListener('abort', () => r(), { once: true }); });
    if (options.abortController!.signal.aborted) throw new Error('aborted');
    if (basedOn !== undefined) service.store.execute(actor, { name: 'room.send', args: { room: actor.channel, basedOn, body: `公开回复:${actor.channel}` }, requestId: randomUUID() });
    if (basedOn !== undefined) service.store.execute(actor, { name: 'room.silence', args: {}, requestId: randomUUID() });
  });
  const a = exec('agent.create', { name: 'A', role: 'test' }) as Agent;
  const b = exec('agent.create', { name: 'B', role: 'test' }) as Agent;
  const room = exec('room.create', { name: 'R', members: [a.id, b.id] }) as Room;
  exec('agent.stop', { id: a.id }); exec('agent.stop', { id: b.id });
  await post('room.send', { room: room.id, body: '开始', mentions: [a.id, b.id] }); await until(() => pending.size === 2);
  pending.get(a.id)!(); pending.get(b.id)!(); await until(() => !service.scheduler.active.size);
  assert.equal(service.store.state.messages.filter(m => m.channel === room.id && m.sender !== 'user').length, 1);
  assert.equal(service.store.state.drafts.filter(d => d.status === 'discarded').length, 1);
  assert.equal(service.store.state.messages.filter(m => m.channel === a.id || m.channel === b.id).length, 0);
  assert.equal(service.store.state.runs.length, 3, '其他成员检查一次新增，沉默不产生新消息');
  pending.clear(); await post('direct.send', { agentId: b.id, text: '私聊工作' }); await until(() => pending.has(b.id));
  await post('room.send', { room: room.id, body: '群聊工作', mentions: [a.id, b.id] }); await until(() => pending.has(a.id));
  const runIds = service.store.state.runs.filter(r => r.channel === room.id && r.status === 'running').map(r => r.id);
  await post('conversation.stop', { channel: room.id, runIds });
  await until(() => !service.scheduler.active.has(a.id));
  assert.ok(service.scheduler.active.has(b.id));
  const runCount = service.store.state.runs.length;
  pending.get(b.id)!(); await until(() => !service.scheduler.active.size);
  assert.equal(service.store.state.runs.length, runCount, '群停止同时取消尚未开始的群待办，保留其它场景执行');
});

test('五人群未 @ 消息全员检查，成员回复检查后静默，不重复处理同一批', async t => {
  const called: string[] = [];
  const { service, exec } = await fixture(t, async (_prompt, options, emit) => {
    const actor = service.scheduler.tokens.get(options.env!.RAFT_RUN_TOKEN!)!;
    if (actor.kind !== 'agent') throw new Error('missing actor');
    const run = service.store.state.runs.find(r => r.id === actor.runId)!;
    const input = service.store.state.inputs.find(i => i.id === run.inputId)!;
    const user = input.messageIds?.some(id => service.store.state.messages.find(m => m.id === id)?.sender === 'user');
    if (!user) { service.store.execute(actor, { name: 'room.silence', args: {}, requestId: randomUUID() }); return; }
    called.push(actor.agentId);
    emit({ type: 'assistant', uuid: randomUUID(), parent_tool_use_id: null, message: { id: randomUUID(), content: [{ type: 'text', text: '大家好' }] } } as SDKMessage);
    const hook = options.hooks!.Stop![0]!.hooks[0]!;
    await hook({ hook_event_name: 'Stop', stop_hook_active: false, session_id: 's', transcript_path: '', cwd: '' }, undefined, { signal: options.abortController!.signal });
    const draft = service.store.state.drafts.find(d => d.runId === actor.runId && d.status === 'held');
    if (draft) service.store.execute(actor, { name: 'draft.resolve', args: { id: draft.id, action: 'retry', basedOn: service.store.state.rooms.find(r => r.id === actor.channel)!.version }, requestId: randomUUID() });

  });
  const members = ['A', 'B', 'C', 'D', 'E'].map(name => exec('agent.create', { name, role: 'test' }) as Agent);
  const room = exec('room.create', { name: '秋招回归', members: members.map(a => a.id) }) as Room;
  exec('room.send', { room: room.id, body: '各位打个招呼' });
  await until(() => called.length === 5 && !service.scheduler.active.size);
  assert.deepEqual([...called].sort(), members.map(a => a.id).sort());
  assert.equal(service.store.state.messages.filter(m => m.sender !== 'user').length, 5);
  assert.ok(members.every(a => !nextSceneInput(service.store.state, a.id)));
  exec('room.send', { room: room.id, body: '各位再见' });
  await until(() => called.length === 10 && !service.scheduler.active.size);
  assert.ok(members.every(a => !nextSceneInput(service.store.state, a.id)));
});

test('运行中 @ 在工具前和结束前提示，view_inbox 只消费当前群并避免重复唤醒', async t => {
  let a: Agent, current: Room, other: Room, calls = 0;
  const { service, exec } = await fixture(t, async (_prompt, options) => {
    calls++;
    const actor = service.scheduler.tokens.get(options.env!.RAFT_RUN_TOKEN!)!;
    if (actor.kind !== 'agent') throw new Error();
    if (actor.channel === other.id) return;
    exec('room.send', { room: current.id, body: '先暂停，核验新需求', mentions: [a.id] });
    exec('room.send', { room: other.id, body: 'OTHER_PRIVATE_CONTEXT', mentions: [a.id] });
    const before = options.hooks!.PreToolUse![0]!.hooks[0]!;
    const event = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 't', tool_input: { command: 'view_inbox' }, session_id: 's', transcript_path: '', cwd: '' } as const;
    const hint = await before(event, 't', { signal: options.abortController!.signal });
    assert.match(JSON.stringify(hint), /view_inbox/);
    assert.doesNotMatch(JSON.stringify(hint), /OTHER_PRIVATE_CONTEXT/);
    const stop = options.hooks!.Stop![0]!.hooks[0]!;
    const stopEvent = { hook_event_name: 'Stop', stop_hook_active: false, session_id: 's', transcript_path: '', cwd: '' } as const;
    assert.equal((await stop(stopEvent, undefined, { signal: options.abortController!.signal }) as { decision: string }).decision, 'block');
    assert.deepEqual(await stop(stopEvent, undefined, { signal: options.abortController!.signal }), {}, '同批不无限阻止结束');
    const result = service.store.execute(actor, { name: 'view_inbox', args: {}, requestId: 'read' }) as { messages: { text: string }[]; remaining: { status: string } };
    assert.deepEqual(result.messages.map(m => m.text), ['先暂停，核验新需求']);
    assert.equal(result.remaining.status, 'none');
    assert.deepEqual(await stop(stopEvent, undefined, { signal: options.abortController!.signal }), {});
    assert.equal(nextSceneInput(service.store.state, a.id)!.channel, other.id);
  });
  a = exec('agent.create', { name: 'A', role: 'test' }) as Agent;
  current = exec('room.create', { name: 'Current', members: [a.id] }) as Room;
  other = exec('room.create', { name: 'Other', members: [a.id] }) as Room;
  exec('room.send', { room: current.id, body: '开始工作' });
  await until(() => calls === 2 && !service.scheduler.active.size);
  assert.equal(service.store.state.runs.filter(r => r.channel === current.id).length, 1);
  assert.equal(nextSceneInput(service.store.state, a.id), undefined);
});
