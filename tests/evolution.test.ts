import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { Options, PreToolUseHookInput, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { startService } from '../src/server.js';
import { evolutionGate, EvolutionService, type EvolutionRunners } from '../src/evolution.js';
import { parseCases, safeFile, checkArtifacts, writeFiles } from '../src/evolution-files.js';
import { trialOptions, TrialRunError } from '../src/evolution-runner.js';
import { ModelSettings } from '../src/model-settings.js';
import type { Evolution, EvolutionTrial } from '../src/evolution-contracts.js';
import { seedEvolution, fakeEvolution, cases, skillDocument, waitFor } from './evolution-fixture.js';
async function fixture(t: import('node:test').TestContext, runners = fakeEvolution) {
  const dir = mkdtempSync(join(tmpdir(), 'raft-evolution-test-'));
  const service = await startService(resolve('.'), dir, { ANTHROPIC_API_KEY: 'fixture-key', ANTHROPIC_MODEL: 'fixture-model' }, async () => {}, undefined, undefined, runners);
  t.after(async () => { await service.close(); rmSync(dir, { recursive: true, force: true }); });
  const seed = await seedEvolution(service);
  const url = `http://127.0.0.1:${service.port}/api/agents/${seed.agent.id}/traces/run/evaluations/evaluation/evolutions`;
  const headers = { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' };
  const post = (path: string, body: unknown = {}) => fetch(url + path, { method: 'POST', headers, body: JSON.stringify(body) });
  return { ...seed, dir, service, url, headers, post };
}
const finish = async (service: Awaited<ReturnType<typeof startService>>, id: string) => { await waitFor(() => !['generating', 'testing'].includes(service.evolution.store.get(id).status)); return service.evolution.store.get(id); };
test('从失败到候选、真实文件断言、新旧重复回归、晋升和回滚；不泄露断言给模型', async t => {
  const seen: { prompt: string; options: Options }[] = [];
  const runners: EvolutionRunners = {
    generate: async (p, o) => { assert.doesNotMatch(p, /"expected"|复制值并保留输入/); return fakeEvolution.generate!(p, o); },
    trial: async (p, o) => { assert.doesNotMatch(p, /"expected"|"checks"/); seen.push({ prompt: p, options: o }); return fakeEvolution.trial!(p, o); },
  };
  const { service, published, post, url, headers } = await fixture(t, runners);
  assert.equal((await fetch(url)).status, 401); assert.equal((await fetch(url + '?conversationId=wrong', { headers })).status, 404);
  assert.equal((await fetch(url, { headers })).status, 200); assert.equal(seen.length, 0);
  const response = await post('', { skillId: published.id, cases }); assert.equal(response.status, 202);
  const initial = await response.json() as Evolution;
  const e = await finish(service, initial.id);
  assert.equal(e.status, 'eligible', e.error); assert.equal(e.trials.length, 4);
  assert.deepEqual(e.trials.map(v => [v.variant, v.passed]), [['baseline', false], ['candidate', true], ['candidate', true], ['baseline', false]]);
  assert.equal(service.skills.catalogView().find(s => s.id === published.id)!.version, published.version, '候选没有提前发布');
  assert.equal(new Set(seen.map(s => s.options.cwd)).size, 4); assert.ok(seen.every(s => !s.options.resume && s.options.env!.RAFT_RUN_TOKEN === undefined));
  assert.equal((await post(`/${e.id}/promote`)).status, 200);
  assert.equal(service.skills.catalogView().find(s => s.id === published.id)!.version, e.candidateVersion);
  assert.equal((await post(`/${e.id}/promote`)).status, 400);
  assert.equal((await post(`/${e.id}/rollback`)).status, 200);
  const current = service.skills.catalogView().find(s => s.id === published.id)!;
  assert.equal(current.version, e.baselineVersion); assert.match(readFileSync(join(current.source, 'SKILL.md'), 'utf8'), /BASELINE/);
  assert.equal(service.evolution.store.get(e.id).status, 'rolled_back');
});
test('无提升、候选失败、重复或缺失试验及执行错误都不能通过门禁', () => {
  const testCase = parseCases(cases)[0]!;
  const make = (variant: 'baseline' | 'candidate', repeat: number, passed: boolean): EvolutionTrial => ({ caseId: 'c1', repeat, variant, status: 'completed', passed, checks: [], artifacts: [], transcript: [], costUsd: 0, durationMs: 1 });
  const trials = [make('baseline', 1, false), make('baseline', 2, false), make('candidate', 1, true), make('candidate', 2, true)];
  const gate = (rows: EvolutionTrial[]) => evolutionGate({ cases: [testCase], repeats: 2, trials: rows }).passed;
  assert.equal(gate(trials), true); assert.equal(gate(trials.slice(1)), false);
  assert.equal(gate([trials[0]!, trials[0]!, trials[2]!, trials[3]!]), false);
  assert.equal(gate(trials.map(v => ({ ...v, passed: true }))), false);
  assert.equal(gate(trials.map(v => v.variant === 'candidate' ? { ...v, passed: false } : v)), false);
  assert.equal(gate(trials.map(v => v.variant === 'baseline' ? { ...v, status: 'error' } : v)), false);
});
test('拒绝弱验收、路径穿越和链接；全文/JSON 验收读取实际产物', t => {
  const dir = mkdtempSync(join(tmpdir(), 'raft-evo-files-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => parseCases([])); assert.throws(() => parseCases([{ ...cases[0], checks: [{ path: 'result.json', kind: 'exists' }] }]));
  assert.throws(() => parseCases([{ ...cases[0], fixtures: [{ path: '../secret.json', text: 'x' }] }]));
  symlinkSync('/tmp', join(dir, 'linked')); assert.throws(() => safeFile(dir, 'linked/a.json'));
  writeFiles(dir, [{ path: 'input.json', text: '{"value":42}' }, { path: 'result.json', text: '{ "value": 42 }' }]);
  assert.ok(checkArtifacts(dir, parseCases(cases)[0]!).every(c => c.passed));
  writeFileSync(join(dir, 'input.json'), 'changed'); assert.equal(checkArtifacts(dir, parseCases(cases)[0]!)[1]!.passed, false);
});
test('工具权限在 hook 层阻断跨目录写入、未知工具和其他 Skill', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'raft-evo-tools-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const work = join(dir, 'work'), plugin = join(dir, 'plugin'); mkdirSync(work); mkdirSync(join(plugin, 'skills/file-report'), { recursive: true });
  const options = trialOptions({ ANTHROPIC_API_KEY: 'test', RAFT_SOCKET: 'private' }, work, plugin, 'file-report', new AbortController(), 1);
  const hook = options.hooks!.PreToolUse![0]!.hooks[0]!;
  const decision = async (tool_name: string, tool_input: unknown) => ((await hook({ hook_event_name: 'PreToolUse', tool_name, tool_input } as PreToolUseHookInput, 'id', { signal: new AbortController().signal })) as SyncHookJSONOutput).hookSpecificOutput as { permissionDecision: string };
  assert.equal((await decision('Write', { file_path: join(work, 'result.json') })).permissionDecision, 'allow');
  assert.equal((await decision('Write', { file_path: join(plugin, 'skills/file-report/SKILL.md') })).permissionDecision, 'deny');
  assert.equal((await decision('Read', { file_path: '/etc/passwd' })).permissionDecision, 'deny');
  assert.equal((await decision('Skill', { skill: 'raft:raft-collaboration' })).permissionDecision, 'deny');
  assert.equal((await decision('Bash', { command: 'touch /tmp/anything' })).permissionDecision, 'deny');
  assert.equal(options.env!.RAFT_SOCKET, undefined);
});
test('候选无法修改脚本或更名；未加载 Skill 的试验不能晋升', async t => {
  const f = await fixture(t, { ...fakeEvolution, generate: async () => ({ costUsd: 0, output: { summary: 'change', applicability: 'all', changes: [{ path: 'scripts/a.txt', text: 'bad' }] } }) });
  const e = f.service.evolution.start('evaluation', { skillId: f.published.id, cases });
  assert.equal((await finish(f.service, e.id)).status, 'failed');
  await assert.rejects(f.service.evolution.switchVersion(e.id, 'evaluation', false));
  const g = await fixture(t, { ...fakeEvolution, trial: async () => ({ costUsd: 0, transcript: [], skillUsed: false }) });
  const e2 = g.service.evolution.start('evaluation', { skillId: g.published.id, cases });
  assert.equal((await finish(g.service, e2.id)).status, 'failed');
});
test('晋升保护正式版本、未发布源码与活动运行；模型变化使实验失效', async t => {
  const f = await fixture(t); const e = await finish(f.service, f.service.evolution.start('evaluation', { skillId: f.published.id, cases }).id);
  const skill = f.service.skills.catalogView().find(s => s.id === f.published.id)!;
  const source = join(skill.source, 'SKILL.md'), original = readFileSync(source, 'utf8'); writeFileSync(source, skillDocument('用户尚未发布的修改'));
  await assert.rejects(f.service.evolution.switchVersion(e.id, 'evaluation', false), /未发布/); writeFileSync(source, original);
  f.service.store.transact(s => { s.runs.find(r => r.id === 'seed')!.status = 'running'; });
  await assert.rejects(f.service.evolution.switchVersion(e.id, 'evaluation', false), /正在运行/);
  f.service.store.transact(s => { s.runs.find(r => r.id === 'seed')!.status = 'done'; });
  await fetch(`http://127.0.0.1:${f.service.port}/api/settings`, { method: 'POST', headers: f.headers, body: JSON.stringify({ baseUrl: 'https://api.anthropic.com', model: 'different' }) });
  await assert.rejects(f.service.evolution.switchVersion(e.id, 'evaluation', false), /模型配置/);
});
test('取消与重启不会自动继续实验；版本切换日志可恢复', async t => {
  const f = await fixture(t, { ...fakeEvolution, generate: async (_p, o) => { await new Promise<void>(r => o.abortController!.signal.addEventListener('abort', () => r(), { once: true })); throw new Error('aborted'); } });
  const e = f.service.evolution.start('evaluation', { skillId: f.published.id, cases });
  assert.throws(() => f.service.evolution.start('evaluation', { skillId: f.published.id, cases }), /正在运行/);
  f.service.evolution.cancel(e.id, 'evaluation'); assert.equal((await finish(f.service, e.id)).status, 'cancelled');
  f.service.evolution.store.save({ ...e, id: 'crashed', status: 'testing' });
  const recovered = new EvolutionService(f.dir, f.service.evaluations, f.service.skills, new ModelSettings(f.dir, {}));
  assert.equal(recovered.store.get('crashed').status, 'interrupted'); assert.equal(recovered.store.get(e.id).status, 'cancelled');
  await recovered.close(); recovered.dispose();
});
test('无提升返回 blocked；预算耗尽不启动回归；正式版本变化阻断晋升', async t => {
  const noGain = await fixture(t, { ...fakeEvolution, trial: async (_p, o) => { writeFileSync(join(o.cwd!, 'result.json'), '{"value":42}'); return { costUsd: 0, transcript: [], skillUsed: true }; } });
  const blocked = await finish(noGain.service, noGain.service.evolution.start('evaluation', { skillId: noGain.published.id, cases }).id);
  assert.equal(blocked.status, 'blocked'); await assert.rejects(noGain.service.evolution.switchVersion(blocked.id, 'evaluation', false));
  let trialCalls = 0;
  const budget = await fixture(t, { generate: async (p, o) => ({ ...await fakeEvolution.generate!(p, o), costUsd: 5 }), trial: async (p, o) => { trialCalls++; return fakeEvolution.trial!(p, o); } });
  const over = await finish(budget.service, budget.service.evolution.start('evaluation', { skillId: budget.published.id, cases }).id);
  assert.equal(over.status, 'failed'); assert.equal(trialCalls, 0); assert.match(over.error!, /预算/);
  const conflict = await fixture(t);
  const e = await finish(conflict.service, conflict.service.evolution.start('evaluation', { skillId: conflict.published.id, cases }).id);
  const skill = conflict.service.skills.catalogView().find(s => s.id === conflict.published.id)!;
  writeFileSync(join(skill.source, 'SKILL.md'), skillDocument('其他用户已经发布新版'));
  await conflict.service.skills.execute({ kind: 'user' }, { name: 'skill.publish', args: { id: skill.id }, requestId: 'other-publish' }, () => undefined);
  await assert.rejects(conflict.service.evolution.switchVersion(e.id, 'evaluation', false), /正式版本已变化/);
});
test('实验冻结模型配置，篡改 Case 快照不能晋升；已提交版本切换恢复为 promoted', async t => {
  let release!: () => void; const seen: unknown[] = [];
  const f = await fixture(t, { generate: async (p, o) => { await new Promise<void>(r => { release = r; }); return fakeEvolution.generate!(p, o); }, trial: async (p, o) => { seen.push(o.model); return fakeEvolution.trial!(p, o); } });
  const e = f.service.evolution.start('evaluation', { skillId: f.published.id, cases });
  await fetch(`http://127.0.0.1:${f.service.port}/api/settings`, { method: 'POST', headers: f.headers, body: JSON.stringify({ baseUrl: 'https://api.anthropic.com', model: 'new-model' }) });
  release(); const done = await finish(f.service, e.id); assert.ok(seen.every(m => m === 'fixture-model'));
  const corrupted = structuredClone(done); corrupted.cases[0]!.checks[0]!.expected = 'different'; f.service.evolution.store.save(corrupted);
  await assert.rejects(f.service.evolution.switchVersion(e.id, 'evaluation', false), /门禁/);
  f.service.evolution.store.save(done);
  await fetch(`http://127.0.0.1:${f.service.port}/api/settings`, { method: 'POST', headers: f.headers, body: JSON.stringify({ baseUrl: 'https://api.anthropic.com', model: 'fixture-model' }) });
  await f.service.evolution.switchVersion(e.id, 'evaluation', false);
  f.service.evolution.store.save({ ...done, status: 'promoting' });
  const recovered = new EvolutionService(f.dir, f.service.evaluations, f.service.skills, new ModelSettings(f.dir, {}));
  assert.equal(recovered.store.get(e.id).status, 'promoted'); await recovered.close(); recovered.dispose();
});

test('SDK 异常保存失败前工具轨迹与实际产物，不能晋升', async t => {
  const f = await fixture(t, { ...fakeEvolution, trial: async (_p, o) => {
    writeFileSync(join(o.cwd!, 'result.json'), '{"value":0}');
    throw new TrialRunError('SDK 流中断', ['已经写入结果，尚未完成任务'], 0.02);
  } });
  const e = await finish(f.service, f.service.evolution.start('evaluation', { skillId: f.published.id, cases }).id);
  assert.equal(e.status, 'failed'); assert.equal(e.gate.passed, false);
  assert.match(e.trials[0]!.transcript.join(''), /已经写入/);
  assert.ok(e.trials[0]!.artifacts.some(f => f.path === 'result.json'));
  assert.equal(e.trials[0]!.costUsd, 0.02);
});
