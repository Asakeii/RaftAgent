import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SDKMessage, Query } from '@anthropic-ai/claude-agent-sdk';
import type { Agent, Room, Snapshot } from '../src/contracts.js';
import { startService } from '../src/server.js';
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

test('群聊显式发送版本竞争保留过时草稿，普通结束说明不发布；群停止不打断其他场景', async t => {
  const pending = new Map<string, () => void>();
  const { service, exec, post } = await fixture(t, async (prompt, options, emit) => {
    const actor = service.scheduler.tokens.get(options.env!.RAFT_RUN_TOKEN!)!;
    assert.equal(actor.kind, 'agent'); if (actor.kind !== 'agent') return;
    const run = service.store.state.runs.find(r => r.agentId === actor.agentId && r.status === 'running')!;
    const input = service.store.state.inputs.find(i => i.id === run.inputId)!;
    const basedOn = service.store.state.rooms.find(r => r.id === actor.channel)?.version;
    // A member reads the shared update and deliberately stays silent without new work.
    if (input.messageIds?.length && input.messageIds.every(id => service.store.state.messages.find(m => m.id === id)?.sender !== 'user')) {
      emit({ type: 'assistant', uuid: randomUUID(), parent_tool_use_id: null, message: { id: randomUUID(), content: [{ type: 'text', text: '无需回复，保持沉默' }] } } as SDKMessage);
      return;
    }
    await new Promise<void>(r => { pending.set(actor.agentId, r); options.abortController!.signal.addEventListener('abort', () => r(), { once: true }); });
    if (options.abortController!.signal.aborted) throw new Error('aborted');
    if (basedOn !== undefined) service.store.execute(actor, { name: 'room.send', args: { room: actor.channel, basedOn, body: `公开回复:${actor.channel}` }, requestId: randomUUID() });
    emit({ type: 'assistant', uuid: randomUUID(), parent_tool_use_id: null, message: { id: randomUUID(), content: [{ type: 'text', text: '本轮处理完成，无需重复发言' }] } } as SDKMessage);
  });
  const a = exec('agent.create', { name: 'A', role: 'test' }) as Agent;
  const b = exec('agent.create', { name: 'B', role: 'test' }) as Agent;
  const room = exec('room.create', { name: 'R', members: [a.id, b.id] }) as Room;
  exec('agent.stop', { id: a.id }); exec('agent.stop', { id: b.id });
  await post('room.send', { room: room.id, body: '开始' }); await until(() => pending.size === 2);
  pending.get(a.id)!(); pending.get(b.id)!(); await until(() => !service.scheduler.active.size);
  assert.equal(service.store.state.messages.filter(m => m.channel === room.id && m.sender !== 'user').length, 1);
  assert.equal(service.store.state.drafts.filter(d => d.status === 'held').length, 1);
  assert.equal(service.store.state.messages.filter(m => m.channel === a.id || m.channel === b.id).length, 0);
  assert.equal(service.store.state.runs.length, 3, '共享更新触发一次评估，成员沉默后停止，不重复处理相同版本');
  pending.clear(); await post('direct.send', { agentId: b.id, text: '私聊工作' }); await until(() => pending.has(b.id));
  await post('room.send', { room: room.id, body: '群聊工作' }); await until(() => pending.has(a.id));
  const runIds = service.store.state.runs.filter(r => r.channel === room.id && r.status === 'running').map(r => r.id);
  await post('conversation.stop', { channel: room.id, runIds });
  await until(() => !service.scheduler.active.has(a.id));
  assert.ok(service.scheduler.active.has(b.id));
  const runCount = service.store.state.runs.length;
  pending.get(b.id)!(); await until(() => !service.scheduler.active.size);
  assert.equal(service.store.state.runs.length, runCount, '群停止同时取消尚未开始的群待办，保留其它场景执行');
});
