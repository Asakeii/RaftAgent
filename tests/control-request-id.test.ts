import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { controlCommand, identifyCommand, sendControl, ControlTransportError } from '../src/control.js';
import { Store } from '../src/store.js';
import type { Command } from '../src/contracts.js';

test('write commands allocate IDs without model input; separate invocations remain separate operations', async () => {
  for (const argv of [
    ['room', 'silence'], ['room', 'send'], ['room', 'retract'], ['draft', 'resolve'],
    ['agent', 'create'], ['agent', 'send'], ['activity', 'report'], ['task', 'claim'], ['task', 'submit'],
    ['inbox', 'ack'], ['view_inbox'], ['skill', 'publish'], ['skill', 'remove'], ['skill', 'reload'],
    ['skill', 'run', '--name', 'raft-local:test', '--script', 'scripts/test.py'],
  ]) {
    const first = await controlCommand(argv, async () => '');
    const second = await controlCommand(argv, async () => '');
    assert.match(first.requestId!, /^[0-9a-f-]{36}$/);
    assert.notEqual(first.requestId, second.requestId);
    assert.equal(identifyCommand(first).requestId, first.requestId);
  }
  const explicit = await controlCommand(['room', 'silence', '--request-id', 'existing-operation'], async () => '');
  assert.equal(explicit.requestId, 'existing-operation');
});

test('lost reply preserves generated ID; explicit retry returns original operation without duplicate side effect', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'raft-request-id-'));
  const store = new Store(join(dir, 'state.sqlite'), join(dir, 'workspaces'));
  const socket = join(dir, 'control.sock'); let requests = 0;
  const server = createServer(connection => {
    let buffer = '';
    connection.on('data', chunk => {
      buffer += String(chunk); if (!buffer.includes('\n')) return;
      const { command } = JSON.parse(buffer); requests++;
      const data = store.execute({ kind: 'user' }, command);
      connection.end(requests === 1 ? '{' : JSON.stringify({ ok: true, data, requestId: command.requestId }));
    });
  });
  await new Promise<void>(resolve => server.listen(socket, resolve));
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const env = { RAFT_SOCKET: socket, RAFT_RUN_TOKEN: 'test' };
  const command: Command = { name: 'agent.create', args: { name: 'A', role: 'test' } };
  await assert.rejects(sendControl(command, env), error => {
    assert.ok(error instanceof ControlTransportError); assert.equal(error.requestId, command.requestId);
    assert.equal(error.outcome, 'unknown'); assert.match(error.message, /not_found 不证明/); return true;
  });
  assert.equal(requests, 1, 'transport must not retry'); assert.equal(store.state.agents.length, 1);
  const retry = await sendControl(command, env);
  assert.equal(retry.requestId, command.requestId); assert.equal(store.state.agents.length, 1);
  await sendControl({ name: command.name, args: command.args }, env);
  assert.equal(store.state.agents.length, 2, 'identical arguments can represent a new intended operation');
});

test('error responses retain the original operation ID; mismatched response IDs are uncertain', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'raft-request-error-')); const socket = join(dir, 's');
  let wrong = false;
  const server = createServer(c => c.once('data', () => c.end(JSON.stringify(wrong ? { ok: true, requestId: 'wrong' } : { ok: false, error: 'denied' }))));
  await new Promise<void>(resolve => server.listen(socket, resolve));
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); });
  const command: Command = { name: 'room.send', args: {}, requestId: 'original' };
  const env = { RAFT_SOCKET: socket, RAFT_RUN_TOKEN: 'test' };
  assert.deepEqual(await sendControl(command, env), { ok: false, error: 'denied', requestId: 'original' });
  wrong = true;
  await assert.rejects(sendControl(command, env), ControlTransportError);
});

test('legacy bundled guidance migrates on startup without overwriting custom text or immutable versions', async t => {
  const { SkillManager } = await import('../src/skills.js');
  const { mkdirSync, writeFileSync, readFileSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'raft-request-guide-'));
  const source = join(dir, 'plugin/skills/raft-collaboration'); mkdirSync(source, { recursive: true });
  const old = '---\nname: raft-collaboration\ndescription: test\n---\n所有写命令需要一个新的稳定 request-id。一次操作的重试必须复用原 ID 和原内容；通信失败先 request status 查询，不生成新 ID 重发。\nraftctl room silence --request-id UNIQUE_ID\nCustom instructions stay.\n';
  writeFileSync(join(source, 'SKILL.md'), old);
  const store = new Store(join(dir, 'state.sqlite'), join(dir, 'workspaces'));
  const skills = new SkillManager(store, join(dir, 'skills'), join(dir, 'plugin'));
  t.after(async () => { await skills.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const previous = skills.catalogView()[0]!;
  const execute = skills.execute.bind(skills);
  skills.execute = () => Promise.reject(new Error('publish interrupted'));
  await assert.rejects(skills.migrateRequestIdGuidance(), /publish interrupted/);
  assert.equal(skills.catalogView()[0]!.version, previous.version);
  skills.execute = execute;
  await skills.migrateRequestIdGuidance();
  const current = skills.catalogView()[0]!;
  assert.notEqual(current.version, previous.version);
  const text = readFileSync(join(current.directory, 'SKILL.md'), 'utf8');
  assert.match(text, /requestId 由 CLI 自动分配/); assert.match(text, /Custom instructions stay/);
  assert.ok(!text.includes('UNIQUE_ID'));
  assert.equal(readFileSync(join(previous.directory, 'SKILL.md'), 'utf8'), old);
  const requests = Object.keys(store.state.requests).length;
  await skills.migrateRequestIdGuidance();
  assert.equal(skills.catalogView()[0]!.version, current.version);
  assert.equal(Object.keys(store.state.requests).length, requests);
});
