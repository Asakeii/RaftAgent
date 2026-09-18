// Opt-in real model regression; isolated data and synthetic conversation only.
import assert from 'node:assert/strict';
import { config } from 'dotenv';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ModelSettings } from '../src/model-settings.js';
import { startService } from '../src/server.js';
import { runSession } from '../src/agent.js';
import type { Agent, Room } from '../src/contracts.js';

config({ quiet: true });
const settings = new ModelSettings(process.env.RAFT_DATA_DIR || join(homedir(), 'Library/Application Support/RaftAgent'), process.env);
assert.ok(settings.view().hasApiKey, 'Configured model required');
const dir = await mkdtemp(join(tmpdir(), 'raft-version-live-'));
const service = await startService(resolve('.'), dir, settings.env,
  (prompt, options, emit, onQuery, inputId) => runSession(prompt, { ...options, maxTurns: 8, maxBudgetUsd: 0.3 }, emit, onQuery, inputId));
const exec = (name: string, args: Record<string, unknown>) => service.store.execute({ kind: 'user' }, { name, args, requestId: randomUUID() });
let report: unknown;
try {
  const members = ['Agent', '技术雷达', '秋招邮箱情报官', 'web信息搜集助手'].map(name => exec('agent.create', {
    name, role: '普通群成员。本次为隔离测试，仅处理群里提供的内容，不访问外部文件、邮箱、网络或其它服务。',
  }) as Agent);
  const room = exec('room.create', { name: '多人招呼版本冲突回归', members: members.map(a => a.id) }) as Room;
  exec('room.send', { room: room.id, body: '各位打个招呼' });
  let idleSince = 0;
  const start = Date.now();
  while (Date.now() - start < 90_000) {
    for (const approval of service.scheduler.approvals.values()) {
      const command = (approval.value.input as { command?: string }).command ?? '';
      approval.resolve(approval.value.tool === 'Bash' && /^(raftctl (inbox list|draft resolve|room silence|message (get|context))|view_inbox)\b/.test(command) && !/[;&|`$<>\n]/.test(command));
    }
    if (service.store.state.runs.length > 20) break;
    if (service.store.state.runs.length && !service.scheduler.active.size) {
      idleSince ||= Date.now();
      if (Date.now() - idleSince > 2000) break;
    } else idleSince = 0;
    await new Promise(r => setTimeout(r, 100));
  }
  const messages = service.store.state.messages.filter(m => m.sender !== 'user');
  const counts = members.map(a => ({ name: a.name, replies: messages.filter(m => m.sender === a.id).length }));
  report = { counts, runs: service.store.state.runs, drafts: service.store.state.drafts, messages, dataDir: dir };
  assert.equal(service.scheduler.active.size, 0, 'Timed out');
  assert.ok(service.store.state.runs.every(r => r.status === 'done'));
  assert.ok(counts.every(c => c.replies === 1), JSON.stringify(counts));
  assert.ok(service.store.state.drafts.some(d => d.holdReason === 'room_changed' && d.status === 'committed'), 'Need an actual conflict and successful reconsideration');
  assert.ok(!service.store.state.drafts.some(d => d.status === 'held'));
  console.log('GROUP_VERSION_LIVE_OK', JSON.stringify(counts));
} finally {
  const out = resolve('.raft/verification'); await mkdir(out, { recursive: true });
  await writeFile(join(out, 'group-version-live.json'), JSON.stringify(report ?? { dataDir: dir, error: 'early failure' }, null, 2));
  await service.close();
}
