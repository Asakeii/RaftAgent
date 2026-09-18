// Explicit live test: isolated synthetic group, real configured model/SDK/Bash/socket.
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
import { nextSceneInput } from '../src/conversation-context.js';

config({ quiet: true });
const settings = new ModelSettings(process.env.RAFT_DATA_DIR || join(homedir(), 'Library/Application Support/RaftAgent'), process.env);
assert.ok(settings.view().hasApiKey, 'No configured model; live test was not run');
const dir = await mkdtemp(join(tmpdir(), 'raft-group-live-'));
const service = await startService(resolve('.'), dir, settings.env,
  (prompt, options, emit, onQuery, inputId) => runSession(prompt, { ...options, maxTurns: 8, maxBudgetUsd: 0.3 }, emit, onQuery, inputId));
const exec = (name: string, args: Record<string, unknown>) => service.store.execute({ kind: 'user' }, { name, args, requestId: randomUUID() });
const results: { scenario: string; runCount: number; silentRuns: number; messages: { sender: string; text: string }[] }[] = [];
let passed = false;
const handoffOnly = process.argv.includes('--handoff-only');
const out = resolve(`.raft/verification/group-routing-live${handoffOnly ? '-handoff' : ''}.json`);
try {
  const roles = [
    ['协调员', '作为普通群成员检查自己的 inbox，不替别人筛选消息；负责明确交接；不复述其他成员已经完成的结果。'],
    ['技术雷达', '技术资料调研。没有新任务或新贡献时调用 room silence。'],
    ['邮箱情报官', '根据用户提供的邮件资料输出具体日程，区分历史日期与当前日期。'],
    ['网页助手', '根据提供的事实回答问题。'],
    ['记录助手', '维护投递记录。仅同步已完成信息且无需操作时调用 room silence。'],
  ];
  const members = roles.map(([name, role]) => exec('agent.create', { name, role: `${role} 本次为隔离测试，仅使用用户提供的虚构资料，不访问真实邮箱、网络、外部文件或外部服务。` }) as Agent);
  const room = exec('room.create', { name: '秋招路由隔离测试', members: members.map(a => a.id) }) as Room;
  const scenario = async (label: string, body: string, targets: Agent[] | undefined, expectedAgents: Agent[]) => {
    const beforeRuns = service.store.state.runs.length;
    const beforeMessages = service.store.state.messages.length;
    exec('room.send', { room: room.id, body, ...(targets ? { mentions: targets.map(a => a.id) } : {}) });
    const started = Date.now(); let idleSince = 0;
    while (Date.now() - started < 90_000) {
      for (const approval of service.scheduler.approvals.values()) {
        const command = (approval.value.input as { command?: string }).command;
        approval.resolve(approval.value.tool === 'Bash' && !!command && /^raftctl (inbox list|room (silence|send))\b/.test(command) && !/[;&|`$<>\n]/.test(command));
      }
      const runs = service.store.state.runs.slice(beforeRuns);
      if (runs.length > 25 || runs.some(r => r.status === 'error')) break;
      if (runs.length && !service.scheduler.active.size) {
        idleSince ||= Date.now();
        if (Date.now() - idleSince >= 3000) break;
      } else idleSince = 0;
      await new Promise(r => setTimeout(r, 100));
    }
    const runs = service.store.state.runs.slice(beforeRuns);
    const messages = service.store.state.messages.slice(beforeMessages).filter(m => m.sender !== 'user');
    const record = { scenario: label, runCount: runs.length, silentRuns: runs.filter(r => r.silent).length, messages: messages.map(m => ({ sender: members.find(a => a.id === m.sender)?.name ?? m.sender, text: m.text })) };
    results.push(record);
    console.log(JSON.stringify(record));
    assert.equal(service.scheduler.active.size, 0, `${label}: timeout`);
    assert.ok(runs.every(r => r.status === 'done'), `${label}: failed run`);
    assert.deepEqual([...new Set(runs.map(r => r.agentId))].sort(), members.map(a => a.id).sort(), `${label}: every member must inspect`);
    assert.ok(expectedAgents.every(a => runs.some(r => r.agentId === a.id)));
    assert.ok(members.every(a => !nextSceneInput(service.store.state, a.id)), `${label}: pending echo`);
    assert.ok(messages.every(m => m.channel === room.id), `${label}: private-chat leak`);
    return { runs, messages };
  };
  if (!handoffOnly) {
  const first = await scenario('定向邮箱回复', '请把这份虚构邮件的日程直接发给我：星河公司，2026-09-20 14:00 视频面试；2026-09-19 18:00 前确认。仅整理这些已提供的事实，无需查询。', [members[2]!], [members[2]!]);
  assert.ok(first.messages.some(m => /星河/.test(m.text) && /14:00/.test(m.text)));
  const silent = await scenario('已完成信息静默', '仅同步：上一条星河公司的面试信息已记录完毕，我也已经看到了。无需更新记录，没有新问题，也不需要确认收到。', [members[4]!], [members[4]!]);
  assert.equal(silent.messages.length, 0, '静默场景不应产生占位消息');
  assert.ok(silent.runs.every(r => r.silent), '必须通过真实工具静默结束');
  const normal = await scenario('无 @ 协调接话', '请用一句话告诉我当前本地年月日和时区，不需要其他成员协助。', undefined, [members[0]!]);
  assert.ok(normal.messages.length > 0);
  }
  await scenario('显式交接', `请通过 raftctl room send 的 --mentions ${members[3]!.id} 向网页助手交接这个问题：“星河公司的面试时间为2026-09-20 14:00，请向用户直接回答这个时间，不要联网”。交接后调用 room silence 结束，不重复发送正文。当前群 ID 为 ${room.id}，请先读取当前版本。`, [members[0]!], [members[0]!, members[3]!]);
  passed = true;
} finally {
  await service.close();
  await mkdir(resolve('.raft/verification'), { recursive: true });
  await writeFile(out, JSON.stringify({ passed, testedAt: new Date().toISOString(), model: settings.view().model, dataDir: dir, results }, null, 2));
  console.log(`GROUP_ROUTING_LIVE_${passed ? 'OK' : 'FAILED'} report=${out}`);
}
