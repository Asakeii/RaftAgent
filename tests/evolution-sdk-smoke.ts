// Real SDK file tools + native Skill against a local provider. No external model calls.
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { trialOptions, runTrial } from '../src/evolution-runner.js';
import { writeFiles } from '../src/evolution-files.js';
import { skillDocument } from './evolution-fixture.js';
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'raft-evo-sdk-'))), work = join(dir, 'work'), plugin = join(dir, 'plugin');
writeFiles(work, [{ path: 'input.json', text: '{"value":42}' }]);
writeFiles(join(plugin, 'skills/file-report'), [{ path: 'SKILL.md', text: skillDocument('读取 input.json 并输出 result.json，保留原始输入。') }]);
mkdirSync(join(plugin, '.claude-plugin')); writeFileSync(join(plugin, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'raft-evolution', version: '1.0.0' }));
const protectedFile = join(dir, 'outside.txt'); writeFileSync(protectedFile, 'protected');
const originalSkill = readFileSync(join(plugin, 'skills/file-report/SKILL.md'), 'utf8');
const steps = [
  { name: 'Skill', input: { skill: 'raft-evolution:file-report' } },
  { name: 'Read', input: { file_path: join(work, 'input.json') } },
  { name: 'Read', input: { file_path: protectedFile } },
  { name: 'Write', input: { file_path: join(dir, 'outside-new.txt'), content: 'ATTACK' } },
  { name: 'Read', input: { file_path: join(plugin, 'skills/file-report/SKILL.md') } },
  { name: 'Write', input: { file_path: join(plugin, 'skills/file-report/SKILL.md'), content: 'ATTACK' } },
  { name: 'Write', input: { file_path: join(work, 'result.json'), content: '{"value":42}' } },
];
let index = 0; const toolsSeen = new Set<string>(); const history: string[] = []; const errors: string[] = [];
const provider = createServer(async (req, res) => {
  try {
    let body = ''; for await (const chunk of req) body += String(chunk);
    if (req.method !== 'POST' || !req.url?.includes('/messages')) { res.end('{}'); return; }
    if (req.url.includes('count_tokens')) { res.end(JSON.stringify({ input_tokens: 100 })); return; }
    const payload = JSON.parse(body); history.push(JSON.stringify(payload.messages));
    for (const tool of payload.tools ?? []) toolsSeen.add(tool.name);
    const tool = payload.tools?.length ? steps[index++] : undefined, text = '已完成';
    const block = tool ? { type: 'tool_use', id: `tool_${randomUUID()}`, name: tool.name, input: tool.input } : { type: 'text', text };
    const usage = { input_tokens: 100, output_tokens: 30 };
    const message = { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: payload.model, content: [block], stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null, usage };
    if (!payload.stream) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(message)); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const event = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    event('message_start', { message: { ...message, content: [], stop_reason: null } });
    event('content_block_start', { index: 0, content_block: tool ? { ...block, input: {} } : { type: 'text', text: '' } });
    event('content_block_delta', { index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) } : { type: 'text_delta', text } });
    event('content_block_stop', { index: 0 }); event('message_delta', { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage }); event('message_stop', {}); res.end();
  } catch (e) { errors.push(String(e)); res.writeHead(500); res.end('{}'); }
});
await new Promise<void>(r => provider.listen(0, '127.0.0.1', r));
const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 45_000);
try {
  const options = trialOptions({ PATH: process.env.PATH, HOME: dir, TMPDIR: tmpdir(), ANTHROPIC_API_KEY: 'local-fixture', ANTHROPIC_BASE_URL: `http://127.0.0.1:${(provider.address() as import('node:net').AddressInfo).port}`, ANTHROPIC_MODEL: 'claude-sonnet-4-5' }, work, plugin, 'file-report', controller, 1);
  const result = await runTrial('先加载 raft-evolution:file-report，再读取 input.json 并输出 result.json。', options);
  assert.equal(result.skillUsed, true, JSON.stringify(result.transcript));
  assert.deepEqual(JSON.parse(readFileSync(join(work, 'result.json'), 'utf8')), { value: 42 });
  assert.equal(existsSync(join(dir, 'outside-new.txt')), false); assert.equal(readFileSync(protectedFile, 'utf8'), 'protected'); assert.equal(readFileSync(join(plugin, 'skills/file-report/SKILL.md'), 'utf8'), originalSkill);
  assert.ok([...toolsSeen].every(t => ['Read', 'Write', 'Edit', 'Skill'].includes(t)), JSON.stringify([...toolsSeen]));
  assert.match(history.at(-1)!, /回归环境文件边界/); assert.deepEqual(errors, []);
  console.log('EVOLUTION_SDK_OK: 原生 Skill 加载、真实文件读写、阻断越界和 Skill 自修改；没有 Bash/联网工具或付费模型调用。');
} finally { clearTimeout(timer); await new Promise<void>(r => provider.close(() => r())); rmSync(dir, { recursive: true, force: true }); }
