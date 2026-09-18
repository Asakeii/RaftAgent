import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ModelUsage, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { calculateCostCny } from '../src/model-pricing.js';
import { ModelSettings } from '../src/model-settings.js';
import { startService } from '../src/server.js';
import type { Agent } from '../src/contracts.js';
const pricing = { input: 2, output: 8, cacheHit: 0.2, cacheHitEnabled: true };
const usage = { inputTokens: 1_000_000, outputTokens: 500_000, cacheReadInputTokens: 2_000_000, cacheCreationInputTokens: 100_000, thinkingTokens: 100_000 } as ModelUsage;

test('人民币计费区分输入、输出、缓存；thinking 不重复收费，缺失用量不伪装为零', () => {
  assert.equal(calculateCostCny({ model: usage }, pricing), 6.6);
  assert.equal(calculateCostCny({ model: usage }, { ...pricing, cacheHitEnabled: false }), 10.2);
  assert.equal(calculateCostCny({ a: usage, b: usage }, pricing), 13.2);
  assert.equal(calculateCostCny({ model: usage }, { ...pricing, input: 0, output: 0, cacheHit: 0 }), 0);
  assert.equal(calculateCostCny({}, pricing), undefined);
  assert.equal(calculateCostCny({ model: { ...usage, inputTokens: NaN } }, pricing), undefined);
  assert.equal(calculateCostCny({ model: { inputTokens: 1 } as ModelUsage }, pricing), undefined);
});

test('价格持久化、校验、清除与旧配置兼容；切换模型时不沿用未显式提交的价格', t => {
  const dir = mkdtempSync(join(tmpdir(), 'raft-pricing-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const settings = new ModelSettings(dir, {});
  const base = { baseUrl: 'https://api.anthropic.com', model: 'test' };
  settings.save(base); assert.equal(new ModelSettings(dir, {}).view().pricing, undefined);
  settings.save({ ...base, pricing });
  assert.deepEqual(new ModelSettings(dir, {}).view().pricing, pricing);
  const original = readFileSync(settings.path, 'utf8');
  for (const bad of [{ ...pricing, input: -1 }, { ...pricing, output: Infinity }, { ...pricing, cacheHit: '2' }, { ...pricing, input: null }, { ...pricing, cacheHitEnabled: 'false' }]) {
    assert.throws(() => settings.save({ ...base, pricing: bad }));
    assert.equal(readFileSync(settings.path, 'utf8'), original);
  }
  settings.save({ ...base, yolo: true }); assert.deepEqual(settings.view().pricing, pricing);
  settings.save({ ...base, model: 'other' }); assert.equal(settings.view().pricing, undefined);
  settings.save({ ...base, pricing }); settings.save({ ...base, pricing: null });
  assert.equal(new ModelSettings(dir, {}).view().pricing, undefined);
});

test('运行开始快照价格；运行中改价不影响本轮，重复 result 不重复计费', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'raft-pricing-run-'));
  let emit: ((message: SDKMessage) => void) | undefined;
  let finish: (() => void) | undefined;
  const service = await startService(resolve('.'), dir, { ANTHROPIC_API_KEY: 'fake' }, async (_prompt, _options, onMessage) => {
    emit = onMessage;
    await new Promise<void>(r => { finish = r; });
  });
  t.after(async () => { finish?.(); await service.close(); rmSync(dir, { recursive: true, force: true }); });
  const save = async (inputPrice: number) => {
    const response = await fetch(`http://127.0.0.1:${service.port}/api/settings`, { method: 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ baseUrl: 'https://api.anthropic.com', model: 'test', pricing: { ...pricing, input: inputPrice } }) });
    assert.equal(response.status, 200);
  };
  await save(2);
  const agent = service.store.execute({ kind: 'user' }, { name: 'agent.create', args: { name: 'Test', role: 'test' }, requestId: 'a' }) as Agent;
  service.store.execute({ kind: 'user' }, { name: 'direct.send', args: { agentId: agent.id, text: 'test' }, requestId: 'b' }); service.scheduler.wake();
  for (let i = 0; !emit && i < 100; i++) await new Promise(r => setTimeout(r, 20));
  assert.ok(emit);
  await save(20);
  const result = { type: 'result', subtype: 'success', duration_ms: 10, duration_api_ms: 8, num_turns: 1, total_cost_usd: 99, modelUsage: { test: usage } } as unknown as SDKMessage;
  emit(result); emit(result);
  const run = service.traces.list(agent.id).runs[0]!;
  assert.deepEqual(run.pricing, pricing); assert.equal(run.costCny, 6.6); assert.equal(run.estimatedCostUsd, 99);
  assert.equal(service.scheduler.pricing()?.input, 20);
});
