import { spawn } from 'node:child_process';
import { extname } from 'node:path';
import { identifyCommand, sendControl } from './control.js';
import type { Command } from './contracts.js';

/** Runs inside the SDK Bash process boundary, never in the service process. */
export async function runSkillScript(command: Command, env: NodeJS.ProcessEnv, send = sendControl) {
  identifyCommand(command);
  const start = await send({ name: 'skill.script.start', args: { name: command.args.name, script: command.args.script }, requestId: command.requestId! }, env);
  if (!start.ok) return start;
  const entry = start.data as { path: string; traceId: string; runId: string; skillId: string; skillVersion: string };
  const interpreter = extname(entry.path) === '.py' ? 'python3' : extname(entry.path) === '.sh' ? 'bash' : process.execPath;
  const exitCode = await new Promise<number | null>(resolve => {
    const child = spawn(interpreter, [entry.path, ...(command.args.argv as string[])], {
      shell: false, stdio: 'inherit', env: { ...env, RAFT_TRACE_ID: entry.traceId, RAFT_RUN_ID: entry.runId, RAFT_SKILL_ID: entry.skillId, RAFT_SKILL_VERSION: entry.skillVersion },
    });
    const interrupt = () => child.kill('SIGINT'); const terminate = () => child.kill('SIGTERM');
    process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
    const done = (code: number | null) => { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); resolve(code); };
    child.once('error', () => done(null)); child.once('close', done);
  });
  const receipt = await send({ name: 'skill.script.finish', args: { exitCode }, requestId: command.requestId! }, env);
  return { ...receipt, ok: receipt.ok && exitCode === 0, exitCode };
}
