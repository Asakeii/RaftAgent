// 本地模拟模型 + 真实 SDK/Skill/Bash/Socket；不调用外部模型。
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { startService } from '../src/server.js';
import { runSession } from '../src/agent.js';
import type { Agent, Room } from '../src/contracts.js';

const dir = await mkdtemp(join(tmpdir(), 'raft-context-sdk-'));
let phase = 'private-first', step = 0, searchRoom = '', referencePath = '';
const payloads = new Map<string, string[]>();
const providerErrors: string[] = [];
const provider = createServer(async (req, res) => {
  try {
    let body = ''; for await (const chunk of req) body += String(chunk);
    if (req.method !== 'POST' || !req.url?.includes('/messages')) { res.end('{}'); return; }
    if (req.url.includes('count_tokens')) { res.end(JSON.stringify({ input_tokens: 100 })); return; }
    const payload = JSON.parse(body);
    const messages = JSON.stringify(payload.messages);
    const history = payloads.get(phase) ?? []; history.push(messages); payloads.set(phase, history);
    const toolSteps = phase === 'group-first' ? [
      { name: 'Skill', input: { skill: 'raft:raft-collaboration' } },
      { name: 'Read', input: { file_path: referencePath } },
      { name: 'Bash', input: { command: `raftctl message search --room '${searchRoom}' --query 'CROSS_ROOM_SECRET' --json` } },
    ] : [];
    const tool = toolSteps[step++];
    const text = phase.startsWith('private') ? 'PRIVATE_RESPONSE' : 'GROUP_EXECUTION_ONLY';
    const block = tool ? { type: 'tool_use', id: `tool_${randomUUID()}`, name: tool.name, input: tool.input } : { type: 'text', text };
    const usage = { input_tokens: 100, output_tokens: 20 };
    const message = { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: payload.model, content: [block], stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null, usage };
    if (!payload.stream) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(message)); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const event = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    event('message_start', { message: { ...message, content: [], stop_reason: null } });
    event('content_block_start', { index: 0, content_block: tool ? { ...block, input: {} } : { type: 'text', text: '' } });
    event('content_block_delta', { index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) } : { type: 'text_delta', text } });
    event('content_block_stop', { index: 0 });
    event('message_delta', { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage });
    event('message_stop', {}); res.end();
  } catch (error) { providerErrors.push(String(error)); res.writeHead(500); res.end('test provider failed'); }
});
await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
const port = (provider.address() as import('node:net').AddressInfo).port;
const sessions: { phase: string; id: string; resume: string | undefined }[] = [];
const service = await startService(resolve('.'), dir, { ...process.env, ANTHROPIC_API_KEY: 'test', ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_MODEL: 'claude-sonnet-4-5', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
  (prompt, options, emit, onQuery, inputId) => runSession(prompt, { ...options, canUseTool: async (_tool, input) => ({ behavior: 'allow', updatedInput: input }) }, message => {
    if (message.type === 'system' && message.subtype === 'init') sessions.push({ phase, id: message.session_id, resume: options.resume });
    emit(message);
  }, onQuery, inputId));
const exec = (name: string, args: Record<string, unknown>) => service.store.execute({ kind: 'user' }, { name, args, requestId: randomUUID() });
try {
  const agent = exec('agent.create', { name: 'Context Probe', role: '本地测试' }) as Agent;
  const spectator = exec('agent.create', { name: 'Stopped', role: 'test' }) as Agent;
  exec('agent.stop', { id: spectator.id });
  const group = exec('room.create', { name: '当前群', members: [agent.id] }) as Room;
  const source = exec('room.create', { name: '目录里的其它群', members: [spectator.id] }) as Room;
  exec('room.send', { room: source.id, body: 'CROSS_ROOM_SECRET' });
  exec('room.members.add', { room: source.id, members: [agent.id] }); // 不回填收件，只有显式检索能取得正文。
  searchRoom = source.id;
  referencePath = join(service.skills.prepare(agent.id, 'raft'), 'skills', 'raft-collaboration', 'references', 'context.md');
  const run = async (next: string, name: string, args: Record<string, unknown>) => {
    phase = next; step = 0;
    const count = service.store.state.runs.length;
    exec(name, args);
    const start = Date.now();
    while (Date.now() - start < 45_000) {
      if (service.store.state.runs.length > count && !service.scheduler.active.size) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(service.store.state.runs.at(-1)?.status, 'done', JSON.stringify(service.store.state.agents));
    assert.ok(payloads.get(next)?.length, `未收到 ${next} 模型请求`);
  };
  await run('private-first', 'direct.send', { agentId: agent.id, text: 'PRIVATE_CONTEXT_MARKER' });
  const privateCount = service.store.state.messages.filter(m => m.channel === agent.id).length;
  await run('group-first', 'room.send', { room: group.id, body: 'GROUP_TRIGGER', mentions: [agent.id] });
  assert.equal(service.store.state.messages.filter(m => m.channel === agent.id).length, privateCount);
  const initial = payloads.get('group-first')![0]!;
  assert.match(initial, /PRIVATE_CONTEXT_MARKER/); assert.match(initial, /conversationId/); assert.match(initial, /GROUP_TRIGGER/);
  assert.doesNotMatch(initial, /CROSS_ROOM_SECRET/);
  const expanded = payloads.get('group-first')!.at(-1)!;
  assert.match(expanded, /按当前场景逐步读取/);
  assert.match(expanded, /CROSS_ROOM_SECRET/);
  const events = service.traces.events(service.traces.list(agent.id).runs[0]!.id).events;
  assert.equal(events.filter(e => e.kind === 'tool.error').length, 0, JSON.stringify(events));
  assert.equal(events.filter(e => e.kind === 'tool.end').length, 3);
  await run('private-again', 'direct.send', { agentId: agent.id, text: 'PRIVATE_FOLLOWUP' });
  const privateAgain = payloads.get('private-again')![0]!;
  assert.match(privateAgain, /PRIVATE_CONTEXT_MARKER/);
  assert.doesNotMatch(privateAgain, /GROUP_TRIGGER|GROUP_EXECUTION_ONLY|CROSS_ROOM_SECRET/);
  await run('group-again', 'room.send', { room: group.id, body: 'GROUP_FOLLOWUP' });
  assert.match(payloads.get('group-again')![0]!, /CROSS_ROOM_SECRET/, '按需读入的正文随本群 resume 保留');
  assert.equal(sessions[0]!.id, sessions[2]!.id); assert.equal(sessions[1]!.id, sessions[3]!.id);
  assert.notEqual(sessions[0]!.id, sessions[1]!.id);
  assert.equal(sessions[2]!.resume, sessions[0]!.id); assert.equal(sessions[3]!.resume, sessions[1]!.id);
  assert.deepEqual(providerErrors, []);
  console.log('CONTEXT_SDK_OK: 真实 SDK 两个场景交替 resume；动态上下文、Skill/引用按需加载、消息检索 CLI 链路、跨群读入保留、私聊不混入群历史均通过。');
} finally {
  await service.close(); await new Promise<void>(resolve => provider.close(() => resolve())); await rm(dir, { recursive: true, force: true });
}
