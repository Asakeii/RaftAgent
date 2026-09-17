import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.js';
import type { Agent, Room, Actor } from '../src/contracts.js';

for (const kind of ['agent', 'room'] as const) test(`${kind} 删除鉴权、运行保护、关联清理与幂等`, t => {
  const dir = mkdtempSync(join(tmpdir(), 'raft-delete-'));
  const store = new Store(':memory:', dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const exec = (name: string, args: Record<string, unknown>) => store.execute({ kind: 'user' }, { name, args, requestId: randomUUID() });
  const a = exec('agent.create', { name: 'A', role: 'test' }) as Agent;
  const b = exec('agent.create', { name: 'B', role: 'test' }) as Agent;
  const room = exec('room.create', { name: 'R', members: [a.id, b.id] }) as Room;
  exec('direct.send', { agentId: a.id, text: 'private' });
  exec('room.send', { room: room.id, body: 'public' });
  exec('task.create', { room: room.id, title: 'task' });
  const command = { name: `${kind}.delete`, args: { id: kind === 'agent' ? a.id : room.id }, requestId: randomUUID() };
  store.transact(s => {
    s.agents[0]!.status = 'running';
    s.runs.push({ id: 'run', agentId: a.id, inputId: 'input', channel: room.id, status: 'running', at: 'now' });
    s.tasks[0]!.owner = a.id; s.tasks[0]!.status = 'working';
    s.sessions!.push({ agentId: a.id, channel: room.id, sdkSessionId: 'session' });
  });
  const actor: Actor = { kind: 'agent', agentId: a.id, runId: 'run', channel: room.id };
  assert.throws(() => store.execute(actor, command), /仅用户/);
  assert.throws(() => store.execute({ kind: 'user' }, command), /先停止/);
  store.transact(s => { s.runs[0]!.status = 'done'; s.agents[0]!.status = 'idle'; });
  const result = store.execute({ kind: 'user' }, command);
  assert.deepEqual(store.execute({ kind: 'user' }, command), result);
  assert.equal(store.state.sessions!.length, 0);
  assert.ok(store.state.agents.some(x => x.id === b.id));
  assert.ok(existsSync(a.workspace));
  if (kind === 'agent') {
    assert.equal(store.state.agents.length, 1);
    assert.deepEqual(store.state.rooms[0]!.members, [b.id]);
    assert.equal(store.state.tasks[0]!.owner, null);
    assert.equal(store.state.tasks[0]!.status, 'pending');
    assert.ok(store.state.messages.some(m => m.channel === room.id));
    assert.ok(!store.state.messages.some(m => m.channel === a.id));
  } else {
    assert.equal(store.state.rooms.length, 0);
    assert.equal(store.state.agents.length, 2);
    assert.equal(store.state.tasks.length, 0);
    assert.ok(!store.state.messages.some(m => m.channel === room.id));
    assert.ok(store.state.messages.some(m => m.channel === a.id));
    store.transact(s => store.delegationResult(s, { id: 'late', agentId: b.id, channel: b.id, returnChannel: room.id, replyToAgentId: a.id, text: '', kind: 'delegated', status: 'done' }, 'late', 'result'));
    assert.ok(!store.state.messages.some(m => m.channel === room.id), '迟到的委派结果不能复活已删除群聊');
  }
});
