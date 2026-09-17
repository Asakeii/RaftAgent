import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Message } from '../src/contracts.js';
import { ReplyStream } from '../src/reply-stream.js';

const event = (event: unknown): SDKMessage => ({ type: 'stream_event', event, parent_tool_use_id: null, uuid: randomUUID(), session_id: 'session' }) as SDKMessage;
const assistant = (id: string, content: unknown[], parent: string | null = null): SDKMessage => ({ type: 'assistant', uuid: randomUUID(), parent_tool_use_id: parent, message: { id, content } }) as SDKMessage;
function fixture() {
  const live = new Map<string, Message>(); const saved: Message[] = [];
  const stream = new ReplyStream('run', 'room', 'agent', live, () => {}, m => saved.push(m));
  return { live, saved, stream, emit: (e: unknown) => stream.accept(event(e)) };
}
test('增量立即可读，按 SDK 内容块完成顺序去重，工具与思考不进入聊天', () => {
  const { live, saved, stream, emit } = fixture();
  emit({ type: 'message_start', message: { id: 'api' } });
  emit({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
  emit({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'PRIVATE' } });
  emit({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
  emit({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '你好' } });
  assert.equal([...live.values()][0]!.text, '你好'); assert.equal(saved.length, 0);
  emit({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '世界' } });
  const complete = assistant('api', [{ type: 'text', text: '你好世界' }]);
  stream.accept(complete); stream.accept(complete);
  emit({ type: 'content_block_stop', index: 1 });
  assert.equal(live.size, 0); assert.equal(saved.length, 1); assert.equal(saved[0]!.text, '你好世界');
  emit({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tool', name: 'Bash', input: {} } });
  emit({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: 'SECRET' } });
  stream.accept(assistant('api', [{ type: 'tool_use', id: 'tool', name: 'Bash', input: { secret: 'SECRET' } }]));
  emit({ type: 'content_block_start', index: 3, content_block: { type: 'text', text: '' } });
  emit({ type: 'content_block_delta', index: 3, delta: { type: 'text_delta', text: '第二段' } });
  stream.accept(assistant('api', [{ type: 'text', text: '第二段' }]));
  stream.accept(assistant('child', [{ type: 'text', text: 'INTERNAL' }], 'tool'));
  stream.close(false);
  assert.deepEqual(saved.map(m => m.text), ['你好世界', '第二段']);
  assert.equal(new Set(saved.map(m => m.id)).size, 2);
  assert.ok(saved.every(m => m.channel === 'room' && !m.delivery));
});
test('停止保留已经显示的半段正文并标记，正常完整消息兼容不提供流式的供应商', () => {
  const { live, saved, stream, emit } = fixture();
  emit({ type: 'message_start', message: { id: 'partial' } });
  emit({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '未完成' } });
  stream.close(true); stream.close(true);
  assert.equal(live.size, 0); assert.equal(saved.length, 1); assert.equal(saved[0]!.delivery, 'interrupted');
  const fallback = fixture();
  fallback.stream.accept(assistant('full', [{ type: 'text', text: '完整回复' }]));
  fallback.stream.close(false); assert.deepEqual(fallback.saved.map(m => m.text), ['完整回复']);
});
