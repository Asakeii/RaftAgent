// Local scripted provider, real SDK Hooks/Bash/CLI/socket. No external model calls.
import { createServer } from 'node:http';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { startService } from '../src/server.js';
import type { Agent, Room } from '../src/contracts.js';
import { inboxSummary } from '../src/shared-inbox.js';
let phase = 'tool', step = 0;
let service: Awaited<ReturnType<typeof startService>>, agent: Agent, room: Room;
const payloads: string[] = [], errors: string[] = [];
const exec = (name: string, args: Record<string, unknown>) => service.store.execute({ kind: 'user' }, { name, args, requestId: randomUUID() });
const provider = createServer(async (req, res) => {
  try {
    let body = ''; for await (const chunk of req) body += String(chunk);
    if (!req.url?.includes('/messages')) { res.end('{}'); return; }
    if (req.url.includes('count_tokens')) { res.end(JSON.stringify({ input_tokens: 100 })); return; }
    const payload = JSON.parse(body); payloads.push(JSON.stringify(payload.messages));
    const n = step++;
    if (n === 1 && phase !== 'tool') {
      assert.match(payloads.at(-1)!, /readInbox/);
      assert.match(payloads.at(-1)!, /draft resolve --id/);
      assert.ok(payloads.at(-1)!.includes(`ARRIVED_MENTION_${phase}`), 'Stop must return current inbox to the same SDK query');
      assert.equal(service.store.state.messages.filter(m => m.sender === agent.id && m.runId === service.store.state.runs.at(-1)!.id).length, 0);
    }
    if (n === 0) exec('room.send', { room: room.id, body: `ARRIVED_MENTION_${phase}`, mentions: [agent.id] });
    const held = service.store.state.drafts.find(d => d.status === 'held');
    const tool = (phase === 'tool' && n === 0) || (phase === 'stop' && n === 1) || (phase === 'draft' && (n === 1 || n === 3));
    let command = `view_inbox`;
    if (phase === 'tool' && n === 0) command = `raftctl skill run --name raft-local:trace-probe --script scripts/probe.mjs && ${command}`;
    if (phase === 'stop' && n === 1) command = `raftctl draft resolve --id '${held!.id}' --action discard && ${command}`;
    if (phase === 'draft' && n === 1) command = `view_inbox && raftctl draft resolve --id '${held!.id}' --action retry --based-on ${service.store.state.rooms[0]!.version}`;
    if (phase === 'draft' && n === 3) command = 'raftctl room silence';
    const input = { command };
    const block = tool ? { type: 'tool_use', id: `tool_${randomUUID()}`, name: 'Bash', input } : { type: 'text', text: '完成当前工作' };
    const usage = { input_tokens: 100, output_tokens: 20 };
    const message = { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: payload.model, content: [block], stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null, usage };
    if (!payload.stream) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(message)); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const event = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    event('message_start', { message: { ...message, content: [], stop_reason: null } });
    event('content_block_start', { index: 0, content_block: tool ? { ...block, input: {} } : { type: 'text', text: '' } });
    event('content_block_delta', { index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(input) } : { type: 'text_delta', text: '完成当前工作' } });
    event('content_block_stop', { index: 0 });
    event('message_delta', { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage });
    event('message_stop', {}); res.end();
  } catch (e) { errors.push(String(e)); res.writeHead(500); res.end('failed'); }
});
await new Promise<void>(r => provider.listen(0, '127.0.0.1', r));
const dir = await mkdtemp(join(tmpdir(), 'raft-inbox-sdk-'));
const port = (provider.address() as import('node:net').AddressInfo).port;
service = await startService(resolve('.'), dir, { ...process.env, ANTHROPIC_API_KEY: 'test', ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_MODEL: 'claude-sonnet-4-5', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });
try {
  agent = exec('agent.create', { name: 'Inbox probe', role: 'test' }) as Agent;
  const source = join(agent.workspace, 'trace-probe');
  await mkdir(join(source, 'scripts'), { recursive: true });
  await writeFile(join(source, 'SKILL.md'), '---\nname: trace-probe\ndescription: sandbox trace test\n---\nUse raftctl skill run.\n');
  await writeFile(join(source, 'scripts/probe.mjs'), "if (!process.env.RAFT_TRACE_ID || !process.env.RAFT_RUN_ID || !process.env.RAFT_SKILL_VERSION) process.exit(1); console.log('SCRIPT_TRACE_OK');");
  service.store.transact(s => { s.agents[0]!.status = 'running'; s.runs.push({ id: 'setup', agentId: agent.id, inputId: 'setup', status: 'running', at: 'now' }); });
  await service.skills.execute({ kind: 'agent', agentId: agent.id, runId: 'setup', channel: agent.id }, { name: 'skill.publish', args: { source }, requestId: 'setup-skill' }, () => undefined);
  service.store.transact(s => { s.agents[0]!.status = 'idle'; s.runs = s.runs.filter(r => r.id !== 'setup'); });
  room = exec('room.create', { name: 'Inbox', members: [agent.id] }) as Room;
  for (const mode of ['tool', 'stop', 'draft']) {
    phase = mode; step = 0; payloads.length = 0;
    const count = service.store.state.runs.length;
    exec('room.send', { room: room.id, body: `START_${phase}` });
    const start = Date.now();
    while (Date.now() - start < 45_000) {
      for (const approval of service.scheduler.approvals.values()) approval.resolve(false);
      if (service.store.state.runs.length > count && !service.scheduler.active.size) break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert.equal(service.scheduler.active.size, 0, `${phase}: timeout`);
    const runs = service.store.state.runs.slice(count);
    assert.equal(runs.length, 1, `${phase}: consumed mention must not start another run`);
    assert.equal(runs[0]!.status, 'done');
    assert.equal(inboxSummary(service.store.state, agent.id, service.store.state.rooms[0]!).status, 'none');
    const events = service.traces.events(runs[0]!.id).events;
    assert.ok(events.some(e => e.kind === 'capability.end' && (e.detail as any)?.skillName === 'raft:raft-collaboration'));
    assert.ok(events.every(e => e.traceId === service.traces.get(runs[0]!.id)!.traceId));
    if (phase === 'tool') {
      assert.equal(service.traces.skillUsage(runs[0]!.id).find(s => s.skillName === 'raft-local:trace-probe')!.processSucceeded, 1);
      assert.ok(payloads.some(p => p.includes('SCRIPT_TRACE_OK')));
    }
    assert.equal(events.filter(e => e.kind === 'tool.error').length, 0, JSON.stringify(events));
    assert.ok(events.some(e => e.kind === 'tool.end' && JSON.stringify(e.detail).includes(`ARRIVED_MENTION_${phase}`)));
    assert.match(payloads.at(-1)!, new RegExp(`ARRIVED_MENTION_${phase}`));
    if (phase === 'stop') assert.ok(step >= 3, 'Stop must continue the same SDK run to read inbox');
    if (phase === 'draft') {
      assert.equal(step, 4);
      const drafts = service.store.state.drafts.filter(d => d.runId === runs[0]!.id);
      assert.deepEqual(drafts.map(d => d.status), ['committed', 'discarded']);
      assert.equal(drafts[1]!.holdReason, 'already_answered');
      assert.equal(service.store.state.messages.filter(m => m.runId === runs[0]!.id).length, 1);
      assert.ok(payloads.some(p => p.includes('already_answered')));
    }
    console.log(`INBOX_SDK_${phase.toUpperCase()}_OK`);
  }
  assert.deepEqual(errors, []);
} finally {
  await service.close(); await new Promise<void>(r => provider.close(() => r())); await rm(dir, { recursive: true, force: true });
}
