import { chromium } from 'playwright';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { startService } from '../src/server.js';
import type { Agent, Room } from '../src/contracts.js';

const dir = await mkdtemp(join(tmpdir(), 'raft-chat-design-'));
const service = await startService(resolve('.'), dir, {}, async () => {});
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
const out = resolve('.raft/verification');
try {
  const exec = (name: string, args: Record<string, unknown>) => service.store.execute({ kind: 'user' }, { name, args, requestId: crypto.randomUUID() });
  const agents = ['技术雷达', '技术教学', '面试分析', 'Asakei'].map((name, i) => exec('agent.create', { name, role: ['关注技术进展，整理值得阅读的内容。', '把复杂的技术讲清楚。', '准备面试，复盘每一次练习。', '一起把想法变成行动。'][i] }) as Agent);
  const room = exec('room.create', { name: '秋招群聊', members: agents.map(a => a.id) }) as Room;
  const messages = [
    { sender: agents[0]!.id, text: '今天我们先把复习方向整理清楚。你可以在群里讨论共同目标，也可以找每位成员单独聊聊。' },
    { sender: 'user', text: '@技术雷达 帮我整理一下这周的学习计划。' },
    { sender: agents[0]!.id, text: '可以，我们把这一周分成三个部分：\n\n1. **基础知识**：梳理 Go 并发、MySQL 索引和 Redis 缓存。\n2. **项目复盘**：从实际代码出发，讲清楚 Agent 的消息与任务流转。\n3. **模拟面试**：每天选一个问题，先口述，再补足细节。\n\n我负责整理资料，技术教学帮助拆解难点，面试分析负责追问和复盘。' },
    { sender: 'user', text: '那今天先从 Go 并发开始，大家一起讨论。' },
    { sender: agents[1]!.id, text: '好，我们从一个具体场景开始：多个 goroutine 同时执行任务，如何等待它们结束，并在发生错误时取消剩余任务？' },
    { sender: agents[2]!.id, text: '我会结合你的回答继续追问，重点看取消信号、资源释放和并发边界。' },
  ];
  service.store.transact(s => messages.forEach((m, i) => s.messages.push({ ...m, id: `design-${i}`, channel: room.id, at: new Date(Date.now() - (messages.length-i)*60000).toISOString(), mentions: [] })));
  await mkdir(out, { recursive: true });
  await page.goto(service.url);
  await page.getByLabel('搜索会话').fill('技术');
  assert.equal(await page.locator('.nav-item').count(), 2);
  await page.getByLabel('搜索会话').fill('不存在');
  await page.getByText('没有找到匹配的会话').waitFor();
  await page.getByLabel('清除搜索').click();
  await page.locator('.room-nav').click();
  await page.locator('.message-bubble .prose').last().waitFor();
  assert.equal(await page.locator('.inspector').count(), 0);
  const user = await page.locator('.user-message .message-bubble').first().evaluate(el => getComputedStyle(el).backgroundColor);
  assert.equal(user, 'rgb(8, 8, 8)');
  await page.getByLabel('提及成员').click();
  await page.getByRole('listbox').waitFor();
  await page.getByLabel('输入消息').press('Enter');
  assert.equal(await page.getByLabel('输入消息').inputValue(), '@技术雷达 ');
  await page.getByLabel('输入消息').fill('');
  // Wait for layout and scroll animations before comparing the visual output.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('.timeline').evaluate(el => { el.scrollTop = 0; });
  await page.screenshot({ path: join(out, 'chat-redesign-desktop.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 850, height: 720 });
  assert.ok(await page.locator('.timeline').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
  await page.screenshot({ path: join(out, 'chat-redesign-narrow.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.getByLabel('输入消息').isVisible());
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: join(out, 'chat-redesign-mobile.png'), animations: 'disabled' });
  await page.getByLabel('返回会话列表').click();
  assert.ok(await page.getByLabel('搜索会话').isVisible());
  await page.locator('.nav-item').filter({ hasText: '技术教学' }).click();
  await page.getByRole('heading', { name: '技术教学', exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log('CHAT_DESIGN_OK: 搜索/空结果/清除、黑色用户气泡、默认收起详情、按钮提及及移动端返回和切换，无模型调用。');
} finally { await browser.close(); await service.close(); await rm(dir, { recursive: true, force: true }); }
