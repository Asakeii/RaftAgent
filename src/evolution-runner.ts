import { query, type Options, type PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { relative, resolve, sep } from 'node:path';
import { realpathSync } from 'node:fs';
import { judgeOptions } from './evaluation-judge.js';
import { safeFile } from './evolution-files.js';
import { inspectionText } from './inspection-redaction.js';
export interface TrialOutput { costUsd: number; transcript: string[]; skillUsed: boolean; }
export class TrialRunError extends Error {
  constructor(message: string, readonly transcript: string[], readonly costUsd?: number) { super(message); }
}
export type TrialRunner = (prompt: string, options: Options) => Promise<TrialOutput>;
export const runTrial: TrialRunner = async (prompt, options) => {
  const stream = query({ prompt, options }); const transcript: string[] = [];
  const secrets = [options.env?.ANTHROPIC_API_KEY ?? ''];
  const skillIds = new Set<string>(); let skillUsed = false;
  try {
    for await (const message of stream) {
      if (message.type === 'assistant') {
        for (const block of message.message.content) if (block.type === 'tool_use' && block.name === 'Skill') skillIds.add(block.id);
        transcript.push(inspectionText(message.message.content, secrets).slice(0, 6000));
      }
      if (message.type === 'user') {
        const content = message.message.content;
        if (Array.isArray(content)) for (const block of content) if (block.type === 'tool_result' && skillIds.has(block.tool_use_id) && !block.is_error) skillUsed = true;
        transcript.push(inspectionText(content, secrets).slice(0, 6000));
      }
      if (transcript.length > 160) throw new Error('回归轨迹超过上限。');
      if (message.type === 'result') {
        if (message.subtype !== 'success' || message.is_error) throw new TrialRunError(`回归 SDK 未成功：${message.subtype}`, transcript, message.total_cost_usd);
        return { costUsd: message.total_cost_usd, transcript, skillUsed };
      }
    }
    throw new Error('回归结果流不完整。');
  } catch (error) {
    if (error instanceof TrialRunError) throw error;
    throw new TrialRunError(error instanceof Error ? error.message : '回归 SDK 出错', transcript);
  } finally { stream.close(); }
};
/** All available file tools are checked by a PreToolUse hook, including auto-allowed calls. No shell/network tools. */
export function trialOptions(env: NodeJS.ProcessEnv, workspace: string, plugin: string, skillName: string, controller: AbortController, budget: number): Options {
  const work = realpathSync(workspace), skillRoot = realpathSync(resolve(plugin, 'skills', skillName));
  const options = judgeOptions(env, work, controller, [], budget);
  delete options.outputFormat;
  const permitted = (tool: string, input: Record<string, unknown>) => {
    if (tool === 'Skill') return input.skill === `raft-evolution:${skillName}`;
    if (!['Read', 'Write', 'Edit'].includes(tool) || typeof input.file_path !== 'string') return false;
    let target = resolve(work, input.file_path);
    // macOS /var is an alias of /private/var. Normalize only our two known roots;
    // safeFile still rejects symlinks underneath those roots.
    for (const [alias, canonical] of [[resolve(workspace), work], [resolve(plugin, 'skills', skillName), skillRoot]]) {
      if (target.startsWith(alias! + sep)) { target = resolve(canonical!, relative(alias!, target)); break; }
    }
    const root = target.startsWith(work + sep) ? work : tool === 'Read' && target.startsWith(skillRoot + sep) ? skillRoot : undefined;
    if (!root) return false;
    try { safeFile(root, relative(root, target).split(sep).join('/')); return true; } catch { return false; }
  };
  return { ...options, maxTurns: 16, tools: ['Read', 'Write', 'Edit', 'Skill'], allowedTools: ['Read', 'Write', 'Edit', 'Skill'],
    plugins: [{ type: 'local', path: realpathSync(plugin), skipMcpDiscovery: true }], skills: ['raft-evolution:' + skillName],
    systemPrompt: '你在独立的文本文件回归环境中完成任务。先加载指定 Skill，然后依据任务修改工作目录内的文件。只有 Read/Write/Edit/Skill；不执行脚本、联网或访问其他目录。真实产物由外部程序验收；你不能修改验收标准。',
    canUseTool: async (tool, input) => permitted(tool, input) ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: '仅允许本次隔离目录中的文本文件操作。' },
    hooks: { PreToolUse: [{ hooks: [async raw => { const input = raw as PreToolUseHookInput; return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: permitted(input.tool_name, input.tool_input as Record<string, unknown>) ? 'allow' : 'deny', permissionDecisionReason: '回归环境文件边界' } }; }] }] },
  };
}
