import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { SkillManager } from '../src/skills.js';
import { TraceStore, RunObserver } from '../src/trace.js';
import { SkillExecutionTrace } from '../src/skill-trace.js';
import { runSkillScript } from '../src/skill-runner.js';
import { controlCommand } from '../src/control.js';
import type { Actor, Agent, Command } from '../src/contracts.js';

function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'raft-skill-trace-'));
  const store = new Store(join(dir, 'store.sqlite'), join(dir, 'workspaces'));
  const skills = new SkillManager(store, join(dir, 'skills'), resolve('resources/raft-plugin'));
  const path = join(dir, 'trace.sqlite'); const traces = new TraceStore(path);
  t.after(async () => { await skills.close(); traces.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const agent = store.execute({ kind: 'user' }, { name: 'agent.create', args: { name: 'Probe', role: 'test' }, requestId: 'create' }) as Agent;
  store.transact(s => { s.agents[0]!.status = 'running'; s.runs.push({ id: 'run', agentId: agent.id, inputId: 'input', status: 'running', at: 'now' }); });
  const actor: Extract<Actor, { kind: 'agent' }> = { kind: 'agent', agentId: agent.id, runId: 'run', channel: agent.id };
  traces.start({ id: 'run', traceId: 'parent-trace', agentId: agent.id, inputId: 'input', channel: agent.id, kind: 'direct', prompt: '', model: 'test', baseUrl: '', startedAt: 'now', status: 'running', phase: 'test' });
  return { dir, path, store, skills, traces, agent, actor, tracker: new SkillExecutionTrace(traces, skills) };
}

test('Skill load, execution, failure, held and replay remain distinct beyond pagination and restart', async t => {
  const { skills, traces, tracker, actor, path, store } = fixture(t);
  const observer = new RunObserver(traces, actor.runId, []);
  const identity = skills.traceSkill(actor.agentId, 'raft:tavily-search')!;
  observer.event('skill.load.start', 'load', identity, { toolId: 'sdk-tool' });
  observer.event('skill.loaded', 'loaded', identity, { toolId: 'sdk-tool' });
  assert.equal(traces.skillUsage('run')[0]!.state, 'loaded_only');
  for (let i = 0; i < 210; i++) observer.event('noise', 'padding');
  await tracker.execute(actor, { name: 'room.send', args: {} }, async () => ({ status: 'held' }));
  await tracker.execute(actor, { name: 'web.search', args: { query: 'private-query' } }, async () => ({ results: [] }));
  await assert.rejects(tracker.execute(actor, { name: 'web.fetch', args: {} }, async () => { throw new Error('secret'); }));
  const command = { name: 'activity.report', args: { text: 'test' }, requestId: 'same' };
  for (let i = 0; i < 2; i++) {
    let replayed = false;
    await tracker.execute(actor, command, async () => store.execute(actor, command, () => { replayed = true; }), () => replayed);
  }
  const summary = traces.skillUsage('run');
  assert.equal(summary.find(s => s.skillName === 'raft:tavily-search')!.serviceFailed, 1);
  assert.equal(summary.find(s => s.skillName === 'raft:raft-collaboration')!.replayed, 1);
  assert.equal(summary.find(s => s.skillName === 'raft:raft-collaboration')!.loaded, 0);
  const events = traces.events('run', 0, 500).events;
  assert.ok(events.every(e => e.traceId === 'parent-trace'));
  assert.ok(events.some(e => (e.detail as any)?.businessStatus === 'held'));
  assert.ok(!JSON.stringify(events).includes('private-query'));
  const reopened = new TraceStore(path);
  try { assert.deepEqual(reopened.skillUsage('run'), summary); } finally { reopened.close(); }
});

test('controlled runner executes published snapshot, injects context, records failures and refuses replays', async t => {
  const { dir, skills, traces, tracker, agent, actor } = fixture(t);
  const source = join(agent.workspace, 'draft'); mkdirSync(join(source, 'scripts'), { recursive: true });
  writeFileSync(join(source, 'SKILL.md'), '---\nname: probe\ndescription: test tracing\n---\nRun script.\n');
  writeFileSync(join(source, 'scripts/probe.mjs'), "import {writeFileSync} from 'node:fs'; writeFileSync(process.argv[2], JSON.stringify([process.env.RAFT_TRACE_ID, process.env.RAFT_RUN_ID, process.env.RAFT_SKILL_ID, process.env.RAFT_SKILL_VERSION, process.argv.slice(3)])); process.exit(Number(process.argv[3] || 0));");
  const first = await skills.execute(actor, { name: 'skill.publish', args: { source: 'draft' }, requestId: 'publish' }, () => undefined) as any;
  skills.prepare(agent.id);
  const entry = skills.scriptEntry(agent.id, 'raft-local:probe', 'scripts/probe.mjs');
  assert.equal(entry.skillVersion, first.version);
  writeFileSync(join(first.source, 'SKILL.md'), '---\nname: probe\ndescription: test tracing\n---\nNew instructions.\n');
  await skills.execute({ kind: 'user' }, { name: 'skill.publish', args: { id: first.id }, requestId: 'update' }, () => undefined);
  assert.equal(skills.scriptEntry(agent.id, 'raft-local:probe', 'scripts/probe.mjs').skillVersion, first.version, 'existing projection stays pinned');
  assert.throws(() => skills.scriptEntry(agent.id, 'missing', 'scripts/probe.mjs'), /未启用/);
  assert.throws(() => skills.scriptEntry(agent.id, 'probe', 'scripts/../../outside'), /scripts/);
  const send = async (command: Command) => ({ ok: true, data: tracker.script(actor, command) });
  const out = join(dir, 'output.json');
  const command = await controlCommand(['skill', 'run', '--name', 'raft-local:probe', '--script', 'scripts/probe.mjs', '--request-id', 'execute', '--', out, '0', '--help', '$(echo nope)'], async () => '');
  const receipt = await runSkillScript(command, { ...process.env, RAFT_TRACE_ID: 'forged' }, send);
  assert.equal(receipt.ok, true);
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), ['parent-trace', 'run', first.id, first.version, ['0', '--help', '$(echo nope)']]);
  await assert.rejects(runSkillScript(command, process.env, send), /禁止自动重复/);
  assert.deepEqual(tracker.script(actor, { name: 'skill.script.finish', args: { exitCode: 0 }, requestId: 'execute' }), { status: 'process_succeeded', exitCode: 0 });
  assert.throws(() => tracker.script(actor, { name: 'skill.script.finish', args: { exitCode: 1 }, requestId: 'execute' }), /冲突/);
  const failed = await runSkillScript({ ...command, requestId: 'fail', args: { ...command.args, argv: [out, '7'] } }, process.env, send);
  assert.equal(failed.ok, false);
  tracker.script(actor, { name: 'skill.script.start', args: { name: 'probe', script: 'scripts/probe.mjs' }, requestId: 'lost' });
  const usage = traces.skillUsage('run').find(s => s.skillId === first.id)!;
  assert.equal(usage.processSucceeded, 1); assert.equal(usage.processFailed, 1); assert.equal(usage.incomplete, 1);
  assert.equal(traces.scriptRequestStatus(agent.id, 'execute')!.status, 'process_succeeded');
  assert.equal(traces.scriptRequestStatus(agent.id, 'lost')!.status, 'unknown');
  assert.equal(traces.scriptRequestStatus('another-agent', 'execute'), undefined);
  assert.throws(() => tracker.script({ ...actor, runId: 'later-run' }, { name: 'skill.script.start', args: command.args, requestId: 'execute' }), /禁止自动重复/);
  const freshTracker = new SkillExecutionTrace(traces, skills);
  assert.throws(() => freshTracker.script(actor, { name: 'skill.script.start', args: command.args, requestId: 'execute' }), /禁止自动重复/);
});

test('runtime hooks and authenticated socket share host context, never ambient trace ID', async t => {
  const { startService } = await import('../src/server.js');
  const { sendControl } = await import('../src/control.js');
  const dir = mkdtempSync(join(tmpdir(), 'raft-skill-hook-'));
  let checked = false;
  const service = await startService(resolve('.'), dir, { ANTHROPIC_API_KEY: 'test', RAFT_TRACE_ID: 'forged', RAFT_RUN_ID: 'forged' }, async (_prompt, options) => {
    const env = options.env!;
    assert.notEqual(env.RAFT_TRACE_ID, 'forged'); assert.notEqual(env.RAFT_RUN_ID, 'forged');
    const pre = options.hooks!.PreToolUse![0]!.hooks[0]!;
    const post = options.hooks!.PostToolUse![0]!.hooks[0]!;
    const context = { signal: options.abortController!.signal };
    const base = { session_id: 's', transcript_path: '', cwd: dir, tool_name: 'Skill' };
    // Interleaved loads must retain their own tool IDs and identities.
    for (const [id, skill] of [['one', 'raft:tavily-search'], ['two', 'raft:raft-collaboration']]) {
      await pre({ ...base, hook_event_name: 'PreToolUse', tool_use_id: id!, tool_input: { skill } }, id, context);
    }
    for (const id of ['two', 'one']) await post({ ...base, hook_event_name: 'PostToolUse', tool_use_id: id, tool_input: {}, tool_response: {} }, id, context);
    const response = await sendControl({ name: 'inbox.list', args: { traceId: 'forged' } }, { ...env, RAFT_TRACE_ID: 'forged' });
    assert.equal(response.ok, true);
    const events = service.traces.events(env.RAFT_RUN_ID!).events;
    const loads = events.filter(e => e.kind === 'skill.loaded');
    assert.deepEqual(loads.map(e => [e.toolId, (e.detail as any).skillName]), [['two', 'raft:raft-collaboration'], ['one', 'raft:tavily-search']]);
    assert.ok(events.every(e => e.traceId === env.RAFT_TRACE_ID));
    assert.equal(service.traces.skillUsage(env.RAFT_RUN_ID!).find(s => s.skillName === 'raft:tavily-search')!.state, 'loaded_only');
    const actor = service.scheduler.tokens.get(env.RAFT_RUN_TOKEN!)!;
    const draft = join(options.cwd!, 'trace-draft'); mkdirSync(join(draft, 'scripts'), { recursive: true });
    writeFileSync(join(draft, 'SKILL.md'), '---\nname: socket-probe\ndescription: test\n---\nRun probe.\n');
    writeFileSync(join(draft, 'scripts/run.mjs'), 'process.exit(process.env.RAFT_TRACE_ID ? 0 : 1);');
    await service.skills.execute(actor, { name: 'skill.publish', args: { source: draft }, requestId: 'publish' }, () => undefined);
    const run = await controlCommand(['skill', 'run', '--name', 'raft-local:socket-probe', '--script', 'scripts/run.mjs'], async () => '');
    assert.equal((await runSkillScript(run, env)).ok, true);
    assert.equal(service.traces.skillUsage(env.RAFT_RUN_ID!).find(s => s.skillName === 'raft-local:socket-probe')!.processSucceeded, 1);
    const status = await sendControl({ name: 'request.status', args: { id: run.requestId } }, env);
    assert.equal((status.data as any).status, 'process_succeeded');
    assert.equal((status.data as any).requestId, run.requestId);
    checked = true;
    return;
  });
  t.after(async () => { await service.close(); rmSync(dir, { recursive: true, force: true }); });
  const agent = service.store.execute({ kind: 'user' }, { name: 'agent.create', args: { name: 'A', role: 'test' }, requestId: 'a' }) as Agent;
  service.store.execute({ kind: 'user' }, { name: 'direct.send', args: { agentId: agent.id, text: 'test' }, requestId: 'input' });
  for (let i = 0; i < 300 && (!checked || service.scheduler.active.size); i++) await new Promise(r => setTimeout(r, 10));
  assert.ok(checked, JSON.stringify(service.store.state.runs));
});
