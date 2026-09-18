// Real SDK against a local Anthropic-compatible fixture; no paid model calls.
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { judgeOptions, runJudge } from '../src/evaluation-judge.js';
const dir = await mkdtemp(join(tmpdir(), 'raft-judge-sdk-'));
const output = { rules: [{ ruleId: 'r1', verdict: 'unknown', reason: '缺少独立产物证据', evidenceRefs: [] }] };
const requests: string[][] = [];
const provider = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += String(chunk);
  if (req.method !== 'POST' || !req.url?.includes('/messages')) { res.end('{}'); return; }
  if (req.url.includes('count_tokens')) { res.end(JSON.stringify({ input_tokens: 100 })); return; }
  const payload = JSON.parse(body);
  const names = (payload.tools ?? []).map((t: { name: string }) => t.name); requests.push(names);
  const tool = names.find((n: string) => /structured/i.test(n));
  const block = tool ? { type: 'tool_use', id: `tool_${randomUUID()}`, name: tool, input: output } : { type: 'text', text: JSON.stringify(output) };
  const usage = { input_tokens: 100, output_tokens: 30 };
  const message = { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: payload.model, content: [block], stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null, usage };
  if (!payload.stream) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(message)); return; }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const event = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  event('message_start', { message: { ...message, content: [], stop_reason: null } });
  event('content_block_start', { index: 0, content_block: tool ? { ...block, input: {} } : { type: 'text', text: '' } });
  event('content_block_delta', { index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(output) } : { type: 'text_delta', text: JSON.stringify(output) } });
  event('content_block_stop', { index: 0 });
  event('message_delta', { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage });
  event('message_stop', {}); res.end();
});
await new Promise<void>(r => provider.listen(0, '127.0.0.1', r));
const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 45_000);
try {
  const options = judgeOptions({ PATH: process.env.PATH, HOME: dir, TMPDIR: tmpdir(), ANTHROPIC_API_KEY: 'local-fixture', ANTHROPIC_BASE_URL: `http://127.0.0.1:${(provider.address() as import('node:net').AddressInfo).port}`, ANTHROPIC_MODEL: 'claude-sonnet-4-5' }, dir, controller, ['r1'], 2);
  const result = await runJudge('评测规则 r1：交付文件。证据只有助手声明完成。', options);
  assert.deepEqual(result.output, output);
  assert.ok(requests.length > 0); assert.ok(requests.flat().every(n => /structured/i.test(n)), JSON.stringify(requests));
  assert.ok(Number.isFinite(result.costUsd));
  console.log('EVALUATION_SDK_OK: SDK 原生 structured_output 可用，业务工具为空，无外部模型调用。', requests);
} finally { clearTimeout(timeout); await new Promise<void>(r => provider.close(() => r())); await rm(dir, { recursive: true, force: true }); }
