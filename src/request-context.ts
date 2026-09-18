import type { AppState, Message } from './contracts.js';
/** Legacy messages inherit the most recent preceding user request, never a future request. */
export function requestForMessage(s: AppState, message: Message): string | undefined {
  if (message.internalFor) return undefined;
  if (message.retractionOf) return message.replyToRequestId;
  if (message.sender === 'user') return message.id;
  if (message.replyToRequestId) return message.replyToRequestId;
  return s.messages.filter(m => m.channel === message.channel && m.sender === 'user' && !m.internalFor && !m.retractedAt && !m.retractionOf && (m.seq ?? 0) < (message.seq ?? 0)).at(-1)?.id;
}
export function requestForInput(s: AppState, channel: string, messageIds: string[] = []) {
  const triggers = s.messages.filter(m => m.channel === channel && messageIds.includes(m.id));
  const userRequest = triggers.filter(m => m.sender === 'user' && !m.internalFor && !m.retractedAt && !m.retractionOf).at(-1);
  if (userRequest) return userRequest.id;
  return triggers.map(m => requestForMessage(s, m)).filter((id): id is string => !!id).at(-1);
}
export function requestState(s: AppState, agentId: string, requestId?: string) {
  const request = s.messages.find(m => m.id === requestId && m.sender === 'user' && !m.internalFor && !m.retractedAt);
  if (!request) return undefined;
  const replies = s.messages.filter(m => m.channel === request.channel && m.sender === agentId && !m.internalFor && !m.retractedAt && !m.retractionOf && requestForMessage(s, m) === requestId);
  return { requestId, requestPreview: request.text.slice(0, 240), status: replies.length ? 'answered' : 'not_answered',
    replyMessageIds: replies.map(m => m.id), lastReply: replies.at(-1)?.text.slice(0, 400) };
}
export function inboxItem(s: AppState, agentId: string, m: Message) {
  return { id: m.id, sender: m.sender, at: m.at, mentioned: m.mentions.includes(agentId),
    source: m.retractionOf ? 'retraction' : m.sender === 'user' ? 'user_request' : m.internalFor ? 'delegation_result' : 'member_update',
    preview: m.text.slice(0, 120), totalChars: m.text.length, request: requestState(s, agentId, requestForMessage(s, m)) };
}
