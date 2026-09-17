import type { AppState, Room } from './contracts.js';
import { DomainError } from './domain-error.js';

export const roomMessages = (s: AppState, roomId: string) => s.messages.filter(m => m.channel === roomId && !m.internalFor);
export const progressKey = (agentId: string, roomId: string) => JSON.stringify([agentId, roomId]);
export const roomProgress = (s: AppState, agentId: string, room: Room) => Math.max(room.memberSince?.[agentId] ?? 0, s.sceneNotices?.[progressKey(agentId, room.id)] ?? 0);
export const pendingRoomMessages = (s: AppState, agentId: string, room: Room) => roomMessages(s, room.id).filter(m => m.sender !== agentId && (m.seq ?? 0) > roomProgress(s, agentId, room));

/** Same public feed and version for every member. Private notifications are separate. */
export function sharedInbox(s: AppState, room: Room, args: Record<string, unknown>) {
  const afterVersion = args.afterVersion ?? 0;
  const limit = args.limit ?? 20;
  if (!Number.isSafeInteger(afterVersion) || Number(afterVersion) < 0 || Number(afterVersion) > room.version) throw new DomainError('afterVersion 无效');
  if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 50) throw new DomainError('limit 无效');
  let version = room.version, afterSeq = 0;
  if (args.cursor !== undefined) {
    try {
      if (typeof args.cursor !== 'string' || args.cursor.length > 2000) throw new Error();
      const cursor = JSON.parse(Buffer.from(args.cursor, 'base64url').toString('utf8'));
      if (cursor.room !== room.id || cursor.afterVersion !== afterVersion || cursor.limit !== limit || !Number.isSafeInteger(cursor.version) || cursor.version < Number(afterVersion) || cursor.version > room.version || !Number.isSafeInteger(cursor.afterSeq) || cursor.afterSeq < 0 || cursor.afterSeq > s.seq) throw new Error();
      version = cursor.version; afterSeq = cursor.afterSeq;
    } catch { throw new DomainError('共享 inbox 游标无效或查询条件已变化'); }
  }
  const messages = roomMessages(s, room.id).filter(m => (m.roomVersion ?? 0) > Number(afterVersion) && (m.roomVersion ?? 0) <= version && (m.seq ?? 0) > afterSeq);
  const page = messages.slice(0, Number(limit));
  return { mode: 'shared' as const, roomId: room.id, version, currentVersion: room.version, changed: room.version !== version,
    messages: page.map(m => ({ ...m, text: m.text.slice(0, 2000), truncated: m.text.length > 2000, totalChars: m.text.length, nextOffset: m.text.length > 2000 ? 2000 : null })),
    nextCursor: messages.length > Number(limit) ? Buffer.from(JSON.stringify({ room: room.id, afterVersion, limit, version, afterSeq: page.at(-1)!.seq })).toString('base64url') : null };
}

/** Upgrade once: public messages remain single-copy; retain only private receipts. */
export function migrateSharedInbox(s: AppState) {
  if (s.sharedInboxVersion === 1) return;
  for (const room of s.rooms) {
    const messages = roomMessages(s, room.id);
    room.version = Math.max(room.version, messages.length);
    const base = room.version - messages.length;
    messages.forEach((m, i) => { m.roomVersion ??= base + i + 1; });
    room.memberSince ??= {};
    for (const id of room.members) {
      const first = messages.find(m => s.receipts.some(r => r.agentId === id && r.messageId === m.id));
      room.memberSince[id] ??= first ? Math.max(0, (first.seq ?? 0) - 1) : messages.at(-1)?.seq ?? 0;
    }
  }
  s.receipts = s.receipts.filter(r => { const m = s.messages.find(m => m.id === r.messageId); return m && (m.internalFor || !s.rooms.some(room => room.id === m.channel)); });
  s.sharedInboxVersion = 1;
}
