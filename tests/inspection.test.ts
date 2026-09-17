import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, statSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { getSessionMessages, type SDKMessage, type SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { normalizeHistory, readHistory } from '../src/history.js';
import { TraceStore, RunObserver } from '../src/trace.js';
import { startService } from '../src/server.js';
import type { Agent } from '../src/contracts.js';
import type { TraceRun, TraceDetail, TraceList } from '../src/inspection-contracts.js';

const row = (type: 'user' | 'assistant', uuid: string, content: unknown): SessionMessage => ({ type, uuid, session_id: 'session', parent_tool_use_id: null, parent_agent_id: null, message: { role: type, content } });
const rows = [row('user', 'input-1', '检查 README'), row('assistant', 'answer-1', [{ type: 'text', text: '正在读取' }, { type: 'thinking', thinking: '检查文件' }, { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/tmp/README.md', apiKey: 'never-show' } }]), row('user', 'result-1', [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'key=live-secret', is_error: true }]), row('user', 'input-2', '继续'), row('assistant', 'answer-2', [{ type: 'text', text: '完成' }])];
const baseRun = (id: string): TraceRun => ({ id, traceId: id, agentId: 'agent', inputId: 'input', channel: 'agent', kind: 'direct', prompt: '测试', model: 'test-model', baseUrl: 'https://example.com', startedAt: new Date().toISOString(), status: 'running', phase: '启动 SDK' });
const waitFor = async (check: () => boolean) => { for (let i = 0; i < 150; i++) { if (check()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('等待测试状态超时'); };

test('历史分段保留工具关联与 thinking，分页不误算轮次，凭据脱敏', async () => {
  const messages = normalizeHistory(rows, ['live-secret'], new Map([['input-1', 'run-1']]));
  assert.deepEqual(messages.map(m => m.turn), [1, 1, 1, 2, 2]);
  assert.equal(messages[2]!.role, 'tool'); assert.equal(messages[2]!.runId, 'run-1');
  assert.equal(messages[2]!.blocks[0]!.toolId, 'tool-1'); assert.equal(messages[2]!.blocks[0]!.error, true);
  assert.equal(messages[1]!.blocks[1]!.kind, 'thinking');
  const manyResults = normalizeHistory([row('user', 'large-result', Array.from({ length: 101 }, () => ({ type: 'tool_result', tool_use_id: 'tool-1', content: 'x' })))], []);
  assert.equal(manyResults[0]!.role, 'tool'); assert.match(manyResults[0]!.blocks.at(-1)!.text, /截断/);
  assert.ok(!JSON.stringify(messages).includes('never-show')); assert.ok(!JSON.stringify(messages).includes('live-secret'));
  const args = { sessionId: 'session', sessions: ['session'], workspace: '/tmp', limit: 2, secrets: [], reader: async () => rows };
  const latest = await readHistory(args); assert.deepEqual(latest.messages.map(m => m.id), ['input-2', 'answer-2']);
  const previous = await readHistory({ ...args, before: latest.nextBefore! });
  assert.deepEqual(previous.messages.map(m => m.turn), [1, 1]); assert.equal(previous.messages[1]!.role, 'tool');
  await assert.rejects(readHistory({ ...args, sessionId: 'unowned' }), /不属于/);
  await assert.rejects(readHistory({ ...args, before: 'missing' }), /已变化/);
});

test('真实 SDK 从隔离的 JSONL 会话读取并关联工具，无需模型调用', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'raft-sdk-history-')); const rawWorkspace = join(dir, 'workspace'); mkdirSync(rawWorkspace); const workspace = realpathSync(rawWorkspace);
  const old = process.env.CLAUDE_CONFIG_DIR; process.env.CLAUDE_CONFIG_DIR = join(dir, 'claude');
  t.after(() => { if (old === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = old; rmSync(dir, { recursive: true, force: true }); });
  const sessionId = randomUUID(); const project = join(process.env.CLAUDE_CONFIG_DIR, 'projects', workspace.replace(/[^a-zA-Z0-9]/g, '-')); mkdirSync(project, { recursive: true });
  const ids = rows.map(() => randomUUID());
  writeFileSync(join(project, sessionId + '.jsonl'), rows.map((r, i) => JSON.stringify({ ...r, uuid: ids[i], sessionId, parentUuid: ids[i - 1] ?? null, cwd: workspace, isSidechain: false, timestamp: new Date().toISOString() })).join('\n') + '\n');
  const real = await getSessionMessages(sessionId, { dir: workspace });
  assert.equal(real.length, rows.length); assert.equal(normalizeHistory(real, [])[2]!.blocks[0]!.toolId, 'tool-1');
});

test('执行事件追加、游标、用量与异常恢复持久化，未收尾记录标记未知', t => {
  const dir = mkdtempSync(join(tmpdir(), 'raft-traces-')); const path = join(dir, 'traces.sqlite'); let traces = new TraceStore(path);
  t.after(() => { traces.close(); rmSync(dir, { recursive: true, force: true }); });
  traces.start(baseRun('one')); const observer = new RunObserver(traces, 'one', ['secret-value']);
  observer.toolStart('tool', 'Bash', { command: 'echo secret-value', password: 'other' });
  observer.message({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 3, retry_delay_ms: 2000, error_status: 429, error: 'rate_limit' } as SDKMessage);
  observer.toolEnd('tool', 'Bash', 'done', false);
  observer.message({ type: 'result', subtype: 'success', is_error: false, result: 'done', duration_ms: 100, duration_api_ms: 80, num_turns: 2, total_cost_usd: 0.02, modelUsage: { test: { inputTokens: 10 } } } as unknown as SDKMessage);
  observer.finish('done'); traces.start(baseRun('two'));
  const firstPage = traces.events('one', 0, 2); assert.equal(firstPage.events.length, 2);
  const nextPage = traces.events('one', firstPage.nextAfter!, 20); assert.ok(nextPage.events.every(e => e.seq > firstPage.nextAfter!));
  const all = JSON.stringify(traces.events('one')); assert.ok(!all.includes('secret-value') && !all.includes('other'));
  assert.equal(traces.get('one')!.estimatedCostUsd, 0.02); assert.ok(traces.events('one').events.some(e => e.kind === 'api.retry' && e.level === 'warn'));
  assert.equal(statSync(path).mode & 0o777, 0o600);
  traces.close(); traces = new TraceStore(path);
  assert.equal(traces.get('one')!.status, 'done'); assert.equal(traces.get('two')!.status, 'unknown');
});

test('查看接口鉴权与会话范围受控，读取不唤醒任务，SDK 事件可查询且服务重启后保留', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'raft-inspection-api-')); let count = 0;
  const service = await startService(resolve('.'), dir, { ANTHROPIC_API_KEY: 'fake-secret' }, async (_prompt, options, emit) => {
    count++;
    emit({ type: 'system', subtype: 'init', session_id: 'owned-session', model: 'test' } as SDKMessage);
    emit({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 3, retry_delay_ms: 1000, error_status: 429, error: 'rate_limit' } as SDKMessage);
    await options.hooks!.PreToolUse![0]!.hooks[0]!({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/tmp/a' }, tool_use_id: 'tool', session_id: 'owned-session', transcript_path: '', cwd: dir }, 'tool', { signal: options.abortController!.signal });
    await options.hooks!.PostToolUse![0]!.hooks[0]!({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: {}, tool_response: 'fake-secret', tool_use_id: 'tool', session_id: 'owned-session', transcript_path: '', cwd: dir }, 'tool', { signal: options.abortController!.signal });
    emit({ type: 'result', subtype: 'success', is_error: false, result: 'done', duration_ms: 42, duration_api_ms: 30, num_turns: 1, total_cost_usd: 0, modelUsage: {} } as unknown as SDKMessage);
  }, async () => rows);
  let reopened: Awaited<ReturnType<typeof startService>> | undefined;
  t.after(async () => { await service.close(); await reopened?.close(); rmSync(dir, { recursive: true, force: true }); });
  const command = (name: string, args: Record<string, unknown>) => service.store.execute({ kind: 'user' }, { name, args, requestId: randomUUID() });
  const agent = command('agent.create', { name: 'A', role: 'test' }) as Agent;
  command('direct.send', { agentId: agent.id, text: 'work' }); command('agent.stop', { id: agent.id });
  const base = `http://127.0.0.1:${service.port}/api/agents/${agent.id}`;
  const headers = { Authorization: `Bearer ${service.token}` };
  assert.equal((await fetch(base + '/history')).status, 401);
  const pending = await fetch(base + '/traces', { headers }).then(r => r.json()) as TraceList;
  assert.equal(pending.pending, 1); assert.equal(pending.agentStatus, 'stopped'); assert.equal(count, 0);
  command('agent.resume', { id: agent.id }); await waitFor(() => count > 0 && service.scheduler.active.size === 0);
  const traces = await fetch(base + '/traces', { headers }).then(r => r.json()) as TraceList;
  assert.equal(traces.runs.length, 1); // 已有排队输入时，继续不会重复生成任务。
  const detail = await fetch(base + '/traces/' + traces.runs[0]!.id, { headers }).then(r => r.json()) as TraceDetail;
  assert.ok(detail.events.some(e => e.kind === 'tool.end')); assert.ok(!JSON.stringify(detail).includes('fake-secret'));
  assert.equal((await fetch(base + '/history?sessionId=unowned', { headers })).status, 400);
  assert.equal((await fetch(base + '/history?limit=-1', { headers })).status, 400);
  const history = await fetch(base + '/history', { headers }).then(r => r.json()); assert.equal(history.total, 5);
  const before = count; await fetch(base + '/traces', { headers }); await new Promise(r => setTimeout(r, 20)); assert.equal(count, before);
  await service.close(); reopened = await startService(resolve('.'), dir, {}, async () => {});
  assert.equal(reopened.traces.get(detail.run.id)!.status, 'done');
});

test('父子 CLI 委派沿用同一 trace，停止被记录，采集失败不阻断业务', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'raft-trace-parent-'));
  const { sendControl } = await import('../src/control.js');
  const service = await startService(resolve('.'), dir, { ANTHROPIC_API_KEY: 'test-key' }, async (prompt, options, emit) => {
    if (prompt === 'spawn') {
      const response = await sendControl({ name: 'agent.create', args: { name: 'Child', systemPrompt: 'test', task: 'child-task' }, requestId: 'spawn-child' }, options.env!); assert.equal(response.ok, true);
    }
    if (prompt === 'wait') await new Promise<void>(resolve => options.abortController!.signal.addEventListener('abort', () => resolve(), { once: true }));
    emit({ type: 'result', subtype: 'success', is_error: false, result: 'done', duration_ms: 20, duration_api_ms: 10, num_turns: 1, total_cost_usd: 0, modelUsage: {} } as unknown as SDKMessage);
  });
  t.after(async () => { await service.close(); rmSync(dir, { recursive: true, force: true }); });
  const command = (name: string, args: Record<string, unknown>) => service.store.execute({ kind: 'user' }, { name, args, requestId: randomUUID() });
  const parent = command('agent.create', { name: 'Parent', role: 'test' }) as Agent;
  command('direct.send', { agentId: parent.id, text: 'spawn' });
  await waitFor(() => service.store.state.agents.length === 2 && service.scheduler.active.size === 0);
  const child = service.store.state.agents.find(a => a.parentAgentId === parent.id)!;
  const childRun = service.traces.list(child.id).runs[0]!;
  const parentRun = service.traces.get(childRun.parentRunId!)!;
  assert.equal(parentRun.agentId, parent.id); assert.equal(childRun.traceId, parentRun.traceId);
  assert.equal(service.traces.related(parentRun.traceId).length, 2);
  command('direct.send', { agentId: parent.id, text: 'wait' });
  await waitFor(() => service.scheduler.active.has(parent.id));
  command('agent.stop', { id: parent.id }); service.scheduler.stop(parent.id);
  await waitFor(() => service.scheduler.active.size === 0);
  assert.equal(service.traces.list(parent.id).runs[0]!.status, 'stopped');
  const broken = new TraceStore(join(dir, 'closed.sqlite')); broken.close();
  assert.doesNotThrow(() => new RunObserver(broken, 'none', []).event('test', 'test'));
  assert.match(broken.warning, /保存失败/);
});
