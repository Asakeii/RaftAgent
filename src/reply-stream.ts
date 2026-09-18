import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Message } from './contracts.js';

type Block = { message: Message; complete: boolean };
/** A presentation adapter for SDK text events; tool/thinking/subagent payloads stay out of chat. */
export class ReplyStream {
  private apiId = '';
  private index = 0;
  private blocks = new Map<string, Block>();
  private seen = new Set<string>();
  constructor(private runId: string, private channel: string, private sender: string,
    private live: Map<string, Message>, private changed: () => void,
    private commit: (message: Message) => void, private prepare: (message: Message) => void = () => {}) {}

  private block(apiId: string, index: number) {
    const id = `reply:${this.runId}:${apiId}:${index}`;
    let block = this.blocks.get(id);
    if (!block) {
      block = { complete: false, message: { id, runId: this.runId, channel: this.channel, sender: this.sender, text: '', at: new Date().toISOString(), mentions: [], delivery: 'streaming' } };
      this.prepare(block.message);
      this.blocks.set(id, block);
    }
    return block;
  }
  private publish(block: Block) {
    if (!block.complete && block.message.text) { this.live.set(block.message.id, { ...block.message }); this.changed(); }
  }
  private finish(block: Block, interrupted = false) {
    if (block.complete) return;
    block.complete = true;
    this.live.delete(block.message.id);
    const message = { ...block.message };
    if (interrupted) message.delivery = 'interrupted'; else delete message.delivery;
    if (message.text) this.commit(message);
    this.changed();
  }
  accept(message: SDKMessage) {
    if (message.type === 'stream_event') {
      if (message.parent_tool_use_id) return;
      const event = message.event;
      if (event.type === 'message_start') { this.apiId = event.message.id; this.index = 0; }
      else if (event.type === 'content_block_start') {
        this.index = event.index;
        if (event.content_block.type === 'text') {
          const block = this.block(this.apiId, event.index);
          block.message.text = event.content_block.text; this.publish(block);
        }
      } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        this.index = event.index;
        const block = this.block(this.apiId, event.index);
        if (!block.complete) { block.message.text += event.delta.text; this.publish(block); }
      }
    } else if (message.type === 'assistant' && !message.parent_tool_use_id) {
      if (this.seen.has(message.uuid)) return;
      this.seen.add(message.uuid);
      const apiId = message.message.id || message.uuid;
      // SDK emits each completed content block separately, before content_block_stop.
      message.message.content.forEach((content, i) => {
        if (content.type !== 'text') return;
        const index = apiId === this.apiId && message.message.content.length === 1 ? this.index : i;
        const block = this.block(apiId, index);
        if (!block.complete) { block.message.text = content.text; this.finish(block); }
      });
    }
  }
  discard() {
    for (const block of this.blocks.values()) { this.live.delete(block.message.id); block.complete = true; }
    this.changed();
  }
  close(interrupted: boolean) {
    for (const block of this.blocks.values()) this.finish(block, interrupted);
  }
}
