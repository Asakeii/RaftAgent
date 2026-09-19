import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Agent } from '../src/contracts.js';
import type { startService } from '../src/server.js';
import type { EvolutionRunners } from '../src/evolution.js';
import { RunObserver } from '../src/trace.js';
import { DEFAULT_EVALUATOR, type Evaluation } from '../src/evaluation-contracts.js';
export const skillDocument = (body: string) => `---\nname: file-report\ndescription: 读取输入并生成 JSON 报告。\n---\n${body}\n`;
export const cases = [{ name: '复制值并保留输入', prompt: '读取 input.json 的 value 并输出 result.json，保留原文件。', fixtures: [{ path: 'input.json', text: '{"value":42}' }], checks: [{ path: 'result.json', kind: 'json', expected: '{"value":42}' }, { path: 'input.json', kind: 'text', expected: '{"value":42}' }] }];
export const fakeEvolution: EvolutionRunners = {
  generate: async () => ({ output: { summary: '修复生成报告时遗漏输入值的问题。', applicability: '有 value 字段的本地 JSON 报告任务。', changes: [{ path: 'SKILL.md', text: skillDocument('CANDIDATE：读取源文件，复制 value 字段，不修改原文件。') }] }, costUsd: 0.01 }),
  trial: async (_prompt, options) => {
    const plugin = options.plugins![0]!;
    const doc = readFileSync(join(plugin.path, 'skills/file-report/SKILL.md'), 'utf8');
    const output = doc.includes('CANDIDATE') ? readFileSync(join(options.cwd!, 'input.json'), 'utf8') : '{"value":0}';
    writeFileSync(join(options.cwd!, 'result.json'), output);
    return { skillUsed: true, costUsd: 0.01, transcript: ['已加载 file-report', '已写入 result.json'] };
  },
};
export async function seedEvolution(service: Awaited<ReturnType<typeof startService>>) {
  const agent = service.store.execute({ kind: 'user' }, { name: 'agent.create', args: { name: 'Evolver', role: '生成文件报告' }, requestId: 'create' }) as Agent;
  service.store.transact(s => { s.agents.find(a => a.id === agent.id)!.status = 'running'; s.runs.push({ id: 'seed', agentId: agent.id, inputId: 'input', status: 'running', at: new Date().toISOString() }); });
  const draft = join(agent.workspace, 'draft'); mkdirSync(draft); writeFileSync(join(draft, 'SKILL.md'), skillDocument('BASELINE：输出 value 为 0 的 JSON 报告。'));
  const published = await service.skills.execute({ kind: 'agent', agentId: agent.id, runId: 'seed', channel: agent.id }, { name: 'skill.publish', args: { source: 'draft' }, requestId: 'publish' }, () => undefined) as { id: string; version: string };
  service.store.transact(s => { s.agents.find(a => a.id === agent.id)!.status = 'idle'; s.runs.find(r => r.id === 'seed')!.status = 'done'; });
  service.traces.start({ id: 'run', traceId: 'trace', agentId: agent.id, channel: agent.id, inputId: 'input', contextVersion: 1, kind: 'direct', prompt: '读取 JSON 并生成结果文件', model: 'fixture-model', baseUrl: 'https://example.com', startedAt: new Date().toISOString(), status: 'running', phase: 'test' });
  const observer = new RunObserver(service.traces, 'run', []); observer.event('tool.end', '写入 result.json', { value: 0 }); observer.finish('done');
  const evaluation: Evaluation = { id: 'evaluation', agentId: agent.id, runId: 'run', scope: 'run', objective: '正确复制原始 value', profile: { ...DEFAULT_EVALUATOR, model: 'fixture-model', ready: true }, sourceRunIds: ['run'], evidence: [{ id: 'event:1', runId: 'run', at: new Date().toISOString(), kind: 'tool.end', text: '{"value":0}', truncated: false }], evidenceHash: 'fixture', status: 'completed', verdict: 'fail', states: [{ id: 'r1', text: '输出 value 应匹配输入', required: true, verdict: 'fail', reason: '输出硬编码为零', evidenceRefs: ['event:1'] }], windows: [], totalWindows: 1, createdAt: new Date().toISOString(), endedAt: new Date().toISOString(), warnings: [], costUsd: 0, costComplete: true };
  service.evaluations.store.save(evaluation);
  return { agent, published, evaluation };
}
export async function waitFor(check: () => boolean) { for (let i = 0; i < 300; i++) { if (check()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('等待实验完成超时'); }
