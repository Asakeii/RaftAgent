import { DatabaseSync } from "node:sqlite";
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { emptyState, type AppState, type Actor, type Command, type Room, type Agent, type Input } from "./contracts.js";

export class DomainError extends Error {}
export function required(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 100_000) throw new DomainError(`${label} 不能为空或过长`);
  return value.trim();
}
const ids = (v: unknown): string[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some(x => typeof x !== "string")) throw new DomainError("需要 ID 数组");
  return [...new Set(v as string[])];
};
export class Store {
  private db: DatabaseSync;
  state: AppState;
  changed: () => void = () => {};
  constructor(path: string, readonly workspaceRoot: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS state(id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL)");
    const row = this.db.prepare("SELECT json FROM state WHERE id=1").get();
    this.state = row ? JSON.parse(String(row.json)) as AppState : emptyState();
  }
  transact<T>(fn: (s: AppState) => T): T {
    const next = structuredClone(this.state);
    const result = fn(next);
    this.db.prepare("INSERT INTO state VALUES(1,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json").run(JSON.stringify(next));
    this.state = next;
    this.changed();
    return result;
  }
  event(s: AppState, type: string, text: string) {
    s.events.push({ seq: ++s.seq, type, text, at: new Date().toISOString() });
    if (s.events.length > 500) s.events.splice(0, s.events.length - 500);
  }
  room(s: AppState, actor: Actor, id: unknown): Room {
    const room = s.rooms.find(r => r.id === id);
    if (!room || (actor.kind === "agent" && !room.members.includes(actor.agentId))) throw new DomainError("房间不存在或无访问权限");
    return room;
  }
  message(s: AppState, room: Room, sender: string, text: string, mentions: string[]) {
    if (mentions.some(id => !room.members.includes(id))) throw new DomainError("@ 目标不是房间成员");
    const msg = { id: randomUUID(), channel: room.id, sender, text, mentions, at: new Date().toISOString() };
    s.messages.push(msg); room.version++;
    this.event(s, "message", `${sender === "user" ? "你" : s.agents.find(a => a.id === sender)?.name} 发布了群消息`);
    for (const agentId of room.members.filter(id => id !== sender)) s.receipts.push({ agentId, messageId: msg.id, read: false, arrival: s.seq });
    return msg;
  }
  delegate(s: AppState, parentId: string, child: Agent, text: string, roomId?: string, originRunId?: string): Input {
    const input: Input = { id: randomUUID(), agentId: child.id, text, channel: roomId ?? child.id, kind: "delegated", replyToAgentId: parentId, ...(originRunId ? { originRunId } : {}), status: "pending" };
    s.inputs.push(input);
    s.messages.push({ id: randomUUID(), channel: child.id, sender: parentId, text, at: new Date().toISOString(), mentions: [] });
    this.event(s, "agent.delegated", `向 ${child.name} 委派任务`);
    return input;
  }
  delegationResult(s: AppState, input: Input, runId: string, text: string) {
    if (!input.replyToAgentId) return;
    const id = `delegation:${runId}`;
    if (s.messages.some(m => m.id === id)) return;
    const child = s.agents.find(a => a.id === input.agentId)!;
    s.messages.push({ id, channel: input.replyToAgentId, sender: child.id, text: `子 Agent ${child.name} 的任务结果（inputId: ${input.id}）：\n${text.slice(0, 20_000)}`, mentions: [], at: new Date().toISOString() });
    this.event(s, "agent.result", `${child.name} 返回委派结果`);
    s.receipts.push({ messageId: id, agentId: input.replyToAgentId, read: false, arrival: s.seq });
  }
  execute(actor: Actor, command: Command): unknown {
    return this.transact(s => {
      if (actor.kind === "agent" && (!s.runs.some(r => r.id === actor.runId && r.agentId === actor.agentId && r.status === "running") || s.agents.find(a => a.id === actor.agentId)?.status !== "running")) throw new DomainError("运行已结束或被停止，命令被拒绝");
      const reads = ["inbox.list", "room.changes", "task.list", "request.status", "agent.list", "agent.status"];
      const writing = !reads.includes(command.name);
      const requestId = writing ? required(command.requestId, "requestId") : command.requestId;
      const scope = actor.kind === "user" ? "user" : actor.agentId;
      const key = `${scope}:${requestId}`;
      const fingerprint = createHash("sha256").update(JSON.stringify({ name: command.name, args: command.args })).digest("hex");
      if (writing && s.requests[key]) {
        if (s.requests[key].fingerprint !== fingerprint) throw new DomainError("同一 requestId 不可用于不同内容");
        return s.requests[key].result;
      }
      const a = command.args;
      const agentOnly = () => { if (actor.kind !== "agent") throw new DomainError("此命令需要 Agent 运行身份"); return actor; };
      const userOnly = () => { if (actor.kind !== "user") throw new DomainError("仅用户可执行"); };
      let result: unknown;
      switch (command.name) {
        case "agent.create": {
          if (s.agents.length >= 12) throw new DomainError("本地版本最多 12 个 Agent");
          const parent = actor.kind === "agent" ? s.agents.find(x => x.id === actor.agentId)! : undefined;
          if (a.workspace !== undefined) throw new DomainError("工作目录由应用自动创建，无需指定");
          const systemPrompt = required(a.systemPrompt ?? a.role, "系统提示词");
          const room = a.room !== undefined ? this.room(s, actor, a.room) : undefined;
          const task = a.task !== undefined ? required(a.task, "初始任务") : undefined;
          const id = randomUUID();
          const agent: Agent = { id, name: required(a.name, "名称"), role: systemPrompt, systemPrompt, workspace: resolve(this.workspaceRoot, id), status: "idle", runs: 0, ...(parent ? { parentAgentId: parent.id } : {}) };
          // 先创建实际目录，再发布身份和任务，确保 SDK 调度时 cwd 已存在。
          mkdirSync(this.workspaceRoot, { recursive: true, mode: 0o700 });
          mkdirSync(agent.workspace, { mode: 0o700 });
          s.agents.push(agent);
          if (room) { room.members.push(agent.id); room.version++; }
          this.event(s, "agent", `创建 ${parent ? "子 Agent " : ""}${agent.name}`);
          if (task && parent) this.delegate(s, parent.id, agent, task, room?.id, actor.kind === "agent" ? actor.runId : undefined);
          else if (task) { s.inputs.push({ id: randomUUID(), agentId: agent.id, text: task, channel: room?.id ?? agent.id, kind: "direct", status: "pending" }); }
          result = agent; break;
        }
        case "agent.list": {
          result = s.agents.filter(x => actor.kind === "user" || x.parentAgentId === actor.agentId); break;
        }
        case "agent.status": case "agent.send": {
          const child = s.agents.find(x => x.id === a.id);
          if (!child || (actor.kind === "agent" && child.parentAgentId !== actor.agentId)) throw new DomainError("子 Agent 不存在或不属于当前 Agent");
          if (command.name === "agent.status") {
            result = { agent: child, pendingInputs: s.inputs.filter(i => i.agentId === child.id && i.status === "pending").length, results: s.messages.filter(m => m.id.startsWith("delegation:") && m.sender === child.id && (actor.kind === "user" || m.channel === actor.agentId)).slice(-5) };
          } else {
            const who = agentOnly();
            const room = a.room !== undefined ? this.room(s, actor, a.room) : undefined;
            if (room && !room.members.includes(child.id)) throw new DomainError("子 Agent 不是此群成员");
            const input = this.delegate(s, who.agentId, child, required(a.task, "任务"), room?.id, who.runId);
            result = { status: "queued", inputId: input.id, agentId: child.id, agentStatus: child.status };
          }
          break;
        }
        case "room.create": {
          userOnly(); const members = ids(a.members);
          if (!members.length || members.some(id => !s.agents.some(x => x.id === id))) throw new DomainError("请选择有效成员");
          const room = { id: randomUUID(), name: required(a.name, "群聊名称"), members, version: 0 };
          s.rooms.push(room); this.event(s, "room", `创建群聊 ${room.name}`); result = room; break;
        }
        case "room.members.add": {
          userOnly();
          const room = this.room(s, actor, a.room); const members = ids(a.members);
          if (!members.length || members.some(id => !s.agents.some(agent => agent.id === id))) throw new DomainError("请选择有效成员");
          const added = members.filter(id => !room.members.includes(id));
          if (added.length) {
            room.members.push(...added); room.version++;
            this.event(s, "room.members", `向 ${room.name} 添加成员：${added.map(id => s.agents.find(agent => agent.id === id)!.name).join("、")}`);
          }
          // 加入仅改变成员关系；历史消息不补投，也不生成新的模型输入。
          result = { room, added }; break;
        }
        case "direct.send": {
          userOnly(); const agent = s.agents.find(x => x.id === a.agentId); if (!agent) throw new DomainError("Agent 不存在");
          const text = required(a.text, "消息");
          s.messages.push({ id: randomUUID(), channel: agent.id, sender: "user", text, at: new Date().toISOString(), mentions: [] });
          s.inputs.push({ id: randomUUID(), agentId: agent.id, text, channel: agent.id, kind: "direct", status: "pending" });
          this.event(s, "input", `向 ${agent.name} 提交输入`); result = { status: "queued" }; break;
        }
        case "room.send": {
          const room = this.room(s, actor, a.room); const body = required(a.body, "正文"); const mentions = ids(a.mentions);
          if (mentions.some(id => !room.members.includes(id))) throw new DomainError("@ 目标无效");
          if (actor.kind === "agent" && (!Number.isInteger(a.basedOn) || a.basedOn !== room.version)) {
            if (!Number.isInteger(a.basedOn) || Number(a.basedOn) < 0) throw new DomainError("需要读取房间并提供 basedOn 版本");
            const draft = { id: randomUUID(), roomId: room.id, agentId: actor.agentId, body, mentions, basedOn: Number(a.basedOn), status: "held" as const };
            s.drafts.push(draft); this.event(s, "draft.held", "房间已有变化，草稿已保留");
            result = { status: "held", draftId: draft.id, currentVersion: room.version, actions: ["revise", "retry", "discard", "force"] };
          } else result = { status: "committed", message: this.message(s, room, actor.kind === "user" ? "user" : actor.agentId, body, mentions), version: room.version };
          break;
        }
        case "draft.resolve": {
          const d = s.drafts.find(x => x.id === a.id); if (!d || (actor.kind === "agent" && actor.agentId !== d.agentId)) throw new DomainError("草稿不存在或无权限");
          const room = this.room(s, actor, d.roomId);
          if (d.status !== "held") throw new DomainError("草稿已处理");
          if (a.action === "discard") { d.status = "discarded"; result = { status: d.status }; }
          else {
            if (!["retry", "revise", "force"].includes(String(a.action))) throw new DomainError("无效草稿操作");
            if (a.action === "revise") d.body = required(a.body, "正文");
            if (a.action !== "force" && a.basedOn !== room.version) result = { status: "held", draftId: d.id, currentVersion: room.version };
            else { this.message(s, room, d.agentId, d.body, d.mentions); d.status = "committed"; result = { status: d.status, version: room.version }; }
          }
          this.event(s, `draft.${String(a.action)}`, `草稿状态：${d.status}`); break;
        }
        case "room.changes": {
          const room = this.room(s, actor, a.room);
          const offset = Math.max(0, Number(a.cursor) || 0); const messages = s.messages.filter(m => m.channel === room.id);
          result = { room, messages: messages.slice(offset, offset + 30), nextCursor: offset + 30 < messages.length ? offset + 30 : null }; break;
        }
        case "inbox.list": {
          const who = agentOnly(); if (a.room) this.room(s, actor, a.room);
          const rows = s.receipts.filter(r => r.agentId === who.agentId && !r.read).map(r => ({ receipt: r, message: s.messages.find(m => m.id === r.messageId)! })).filter(r => !a.room || r.message.channel === a.room);
          const cursorIndex = a.cursor ? s.messages.findIndex(m => m.id === a.cursor && s.receipts.some(r => r.agentId === who.agentId && r.messageId === m.id)) : -1;
          if (a.cursor && cursorIndex < 0) throw new DomainError("无效游标");
          const remaining = rows.filter(r => s.messages.findIndex(m => m.id === r.message.id) > cursorIndex);
          const take = remaining.slice(0, 20);
          result = { messages: take.map(r => r.message), rooms: s.rooms.filter(r => r.members.includes(who.agentId)).map(r => ({ id: r.id, name: r.name, version: r.version })), nextCursor: remaining.length > 20 ? take.at(-1)?.message.id : null };
          break;
        }
        case "inbox.ack": {
          const who = agentOnly(); const messageIds = ids(a.ids);
          if (messageIds.some(id => !s.receipts.some(r => r.agentId === who.agentId && r.messageId === id))) throw new DomainError("消息不属于此接收者");
          for (const r of s.receipts) if (r.agentId === who.agentId && messageIds.includes(r.messageId)) r.read = true;
          result = { acknowledged: messageIds }; break;
        }
        case "task.create": {
          userOnly(); const room = this.room(s, actor, a.room);
          const task = { id: randomUUID(), roomId: room.id, title: required(a.title, "任务标题"), owner: null, status: "pending" as const, version: 0, evidence: "" };
          s.tasks.push(task); this.message(s, room, "user", `新任务：${task.title}\n任务 ID：${task.id}`, []); result = task; break;
        }
        case "task.list": this.room(s, actor, a.room); result = s.tasks.filter(t => t.roomId === a.room); break;
        case "task.claim": case "task.submit": case "task.complete": {
          const task = s.tasks.find(t => t.id === a.id); if (!task) throw new DomainError("任务不存在");
          const room = this.room(s, actor, task.roomId);
          if (a.expectedVersion !== task.version) throw new DomainError("任务版本已变化，请重新查询");
          if (command.name === "task.claim") {
            const who = agentOnly(); if (task.status !== "pending") throw new DomainError("任务已被领取");
            task.owner = who.agentId; task.status = "working";
          } else if (command.name === "task.submit") {
            if (actor.kind !== "agent" || task.owner !== actor.agentId || task.status !== "working") throw new DomainError("仅负责人可提交执行中的任务");
            task.evidence = required(a.evidence, "产物与验证说明"); task.status = "reviewing";
          } else { userOnly(); if (task.status !== "reviewing") throw new DomainError("任务尚未提交审查"); task.status = "done"; }
          task.version++; room.version++; this.event(s, "task", `${task.title} → ${task.status}`); result = task; break;
        }
        case "activity.report": {
          const who = agentOnly(); s.activities.push({ id: randomUUID(), runId: who.runId, agentId: who.agentId, channel: who.channel, text: required(a.text, "活动摘要"), status: "note", at: new Date().toISOString() }); result = { status: "recorded" }; break;
        }
        case "agent.stop": case "agent.resume": {
          userOnly(); const agent = s.agents.find(x => x.id === a.id); if (!agent) throw new DomainError("Agent 不存在");
          if (command.name === "agent.resume" && s.runs.some(r => r.agentId === agent.id && r.status === "running")) throw new DomainError("旧执行尚未收尾");
          agent.status = command.name === "agent.stop" ? "stopped" : "idle"; delete agent.error;
          if (command.name === "agent.resume") {
            agent.runs = 0;
            for (const i of s.inputs) if (i.agentId === agent.id && i.status === "unknown") i.status = "done";
            if (!s.inputs.some(i => i.agentId === agent.id && i.status === "pending")) s.inputs.push({ id: randomUUID(), agentId: agent.id, channel: agent.id, kind: "inbox", status: "pending", text: "用户明确允许继续。先检查当前状态和 inbox，不直接重放旧命令；未知执行结果先核验，没有待办时结束。" });
          }
          this.event(s, command.name, `${agent.name} ${agent.status}`); result = { status: agent.status }; break;
        }
        case "request.status": result = s.requests[`${scope}:${required(a.id, "请求 ID")}`]?.result ?? { status: "not_found" }; break;
        default: throw new DomainError(`未知命令：${command.name}`);
      }
      if (writing) s.requests[key] = { fingerprint, result };
      return result;
    });
  }
  recover() {
    this.transact(s => {
      for (const r of s.runs) if (r.status === "running") { r.status = "unknown"; const a = s.agents.find(x => x.id === r.agentId)!; a.status = "error"; a.error = "上次运行异常退出，结果待核验。确认旧操作后点击继续。"; }
      for (const i of s.inputs) if (i.status === "running") i.status = "unknown";
      // 保留消息，启动时不自动复活之前的工作；用户明确继续后调度。
      for (const a of s.agents) if (a.status === "idle") a.status = "stopped";
    });
  }
  close() { this.db.close(); }
}
