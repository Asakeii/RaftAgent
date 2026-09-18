import { chromium } from 'playwright';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { startService } from '../src/server.js';
import type { Agent, Room } from '../src/contracts.js';

const dir = await mkdtemp(join(tmpdir(), 'raft-context-ui-'));
const service = await startService(resolve('.'), dir, {}, async () => {}, async sessionId => [{
  type: 'user', uuid: `input-${sessionId}`, session_id: sessionId, parent_tool_use_id: null, parent_agent_id: null,
  message: { role: 'user', content: `历史正文 ${sessionId}` },
}]);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
try {
  const exec = (name: string, args: Record<string, unknown>, requestId: string) => service.store.execute({ kind: 'user' }, { name, args, requestId });
  const a = exec('agent.create', { name: 'Atlas', role: '实现' }, 'a') as Agent;
  const b = exec('agent.create', { name: 'Sage', role: '审查' }, 'b') as Agent;
  const room = exec('room.create', { name: '开发群', members: [a.id, b.id] }, 'r') as Room;
  exec('direct.send', { agentId: a.id, text: '私聊消息' }, 'dm');
  exec('room.send', { room: room.id, body: '群聊公开消息' }, 'group');
  service.store.transact(s => {
    s.agents[0]!.sessionId = 'legacy-mixed';
    s.sessions!.push({ agentId: a.id, channel: a.id, sdkSessionId: 'private-atlas' }, { agentId: a.id, channel: room.id, sdkSessionId: 'group-atlas' }, { agentId: b.id, channel: room.id, sdkSessionId: 'group-sage' });
    s.messages.push({ id: 'internal-result', channel: room.id, internalFor: a.id, sender: b.id, text: '不能作为群发言显示的内部结果', at: new Date().toISOString(), mentions: [] });
  });
  for (const [agentId, channel, id] of [[a.id, a.id, 'private-atlas'], [a.id, room.id, 'group-atlas'], [b.id, room.id, 'group-sage']]) {
    service.traces.start({ id: id!, traceId: id!, agentId: agentId!, channel: channel!, contextVersion: 1, inputId: `input-${id}`, sessionId: id!, kind: 'test', prompt: `执行任务 ${id}`, model: 'fixture', baseUrl: 'https://example.com', startedAt: new Date().toISOString(), status: 'done', phase: '完成' });
  }
  await page.goto(service.url);
  await page.locator('.sidebar').getByRole('button', { name: /开发群/ }).click();
  await page.getByText('群聊公开消息', { exact: true }).waitFor();
  assert.equal(await page.getByText('不能作为群发言显示的内部结果', { exact: true }).count(), 0);
  await page.getByRole('button', { name: '监测系统', exact: true }).click();
  await page.getByLabel('监测 Agent').selectOption(a.id);
  await page.getByRole('button', { name: '会话详情', exact: true }).click();
  await page.getByText('历史正文 group-atlas', { exact: true }).waitFor();
  assert.equal(await page.getByText('历史正文 private-atlas', { exact: true }).count(), 0);
  await page.getByLabel('监测 Agent').selectOption(b.id);
  await page.getByText('历史正文 group-sage', { exact: true }).waitFor();
  assert.equal(await page.getByText('历史正文 group-atlas', { exact: true }).count(), 0);
  const output = resolve('.raft/verification'); await mkdir(output, { recursive: true });
  await page.screenshot({ path: join(output, 'group-context.png') });
  await page.getByRole('button', { name: '执行日志', exact: true }).click();
  await page.getByRole('button', { name: /执行任务 group-sage/ }).click();
  await page.getByText('运行配置与用量', { exact: true }).waitFor();
  await page.getByLabel('监测会话范围').selectOption(a.id);
  await page.getByRole('button', { name: '会话详情', exact: true }).click();
  await page.getByText('历史正文 private-atlas', { exact: true }).waitFor();
  assert.equal(await page.getByText('历史正文 group-sage', { exact: true }).count(), 0);
  await page.getByLabel('选择历史会话').selectOption('__archive__');
  await page.getByText('历史正文 legacy-mixed', { exact: true }).waitFor();
  await page.getByLabel('选择历史会话').selectOption('__current__');
  await page.getByText('历史正文 private-atlas', { exact: true }).waitFor();
  await page.setViewportSize({ width: 850, height: 720 });
  await page.getByLabel('监测会话范围').selectOption(room.id);
  await page.getByRole('button', { name: '会话详情', exact: true }).click();
  await page.getByText('历史正文 group-atlas', { exact: true }).waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: join(output, 'group-context-narrow.png') });
  assert.deepEqual(errors, []);
  console.log('CONTEXT_UI_OK: 群内切换成员上下文/日志、私聊范围、显式旧会话归档、内部结果隐藏和窄屏验证通过。');
} finally { await browser.close(); await service.close(); await rm(dir, { recursive: true, force: true }); }
