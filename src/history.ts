import { getSessionMessages, type SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import type { HistoryMessage, HistoryPage, HistoryBlock } from './inspection-contracts.js';
import { inspectionText } from './inspection-redaction.js';
import { DomainError } from './store.js';

export type HistoryReader = typeof getSessionMessages;
const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
export function normalizeHistory(rows: SessionMessage[], secrets: string[], runInputs: Map<string, string> = new Map()): HistoryMessage[] {
  let turn = 0; let runId: string | undefined;
  return rows.map(row => {
    const message = record(row.message);
    const content = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : Array.isArray(message.content) ? message.content : [];
    const blocks: HistoryBlock[] = content.slice(0, 100).map(value => {
      const b = record(value); const kind = typeof b.type === 'string' ? b.type : 'unknown';
      const toolId = typeof b.tool_use_id === 'string' ? b.tool_use_id : typeof b.id === 'string' ? b.id : undefined;
      if (kind === 'tool_use') return { kind, name: String(b.name ?? 'Tool'), text: inspectionText(b.input, secrets), ...(toolId ? { toolId } : {}) };
      if (kind === 'tool_result') return { kind, text: inspectionText(b.content, secrets), error: b.is_error === true, ...(toolId ? { toolId } : {}) };
      if (kind === 'text' || kind === 'thinking') return { kind, text: inspectionText(b.text ?? b.thinking ?? '', secrets) };
      return { kind, text: kind === 'redacted_thinking' ? '此思考块不可见。' : `[${kind} 内容不在日志中展开]` };
    });
    if (content.length > 100) blocks.push({ kind: 'notice', text: '[内容块超过 100 条，其余已截断]' });
    const toolOnly = content.length > 0 && content.every(b => record(b).type === 'tool_result');
    if (row.type === 'user' && !toolOnly) { turn++; runId = runInputs.get(row.uuid); }
    const at = (row as unknown as Record<string, unknown>).timestamp;
    return { id: row.uuid, role: row.type === 'assistant' ? 'assistant' : row.type === 'system' ? 'system' : toolOnly ? 'tool' : 'input', turn,
      ...(typeof at === 'string' ? { at } : {}), ...(typeof message.model === 'string' ? { model: message.model } : {}), ...(runInputs.get(row.uuid) || runId ? { runId: runInputs.get(row.uuid) || runId! } : {}),
      blocks: blocks.length ? blocks : [{ kind: 'system', text: inspectionText(row.message, secrets) }] };
  });
}
export async function readHistory(options: { sessionId: string | null; sessions: string[]; workspace: string; before?: string; limit: number; secrets: string[]; runInputs?: Map<string, string>; reader?: HistoryReader }): Promise<HistoryPage> {
  const { sessionId, sessions } = options;
  if (!sessionId) return { sessionId, sessions, messages: [], total: 0, nextBefore: null };
  if (!sessions.includes(sessionId)) throw new DomainError('会话不属于此 Agent。');
  // SDK 负责解析会话链。先计算输入分段，再切页，避免一页从工具结果开始时误算轮次。
  const rows = await (options.reader ?? getSessionMessages)(sessionId, { dir: options.workspace, includeSystemMessages: true });
  const end = options.before ? rows.findIndex(r => r.uuid === options.before) : rows.length;
  if (end < 0) throw new DomainError('会话记录已变化，请刷新后重新加载。');
  const start = Math.max(0, end - options.limit);
  return { sessionId, sessions, messages: normalizeHistory(rows, options.secrets, options.runInputs).slice(start, end), total: rows.length, nextBefore: start > 0 ? rows[start]!.uuid : null };
}
