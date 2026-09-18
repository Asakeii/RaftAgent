import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { readFile } from "node:fs/promises";
import type { Command } from "./contracts.js";

/** One ID per command object, allocated before transport; a fresh command is a new operation. */
export function identifyCommand(command: Command): Command & { requestId: string } {
  command.requestId ??= randomUUID();
  if (!command.requestId.trim() || command.requestId.length > 150) throw new Error('request-id 无效');
  return command as Command & { requestId: string };
}
export class ControlTransportError extends Error {
  readonly outcome = 'unknown';
  constructor(message: string, readonly requestId: string) {
    super(`${message}；结果待核验，未自动重试。请按回执 requestId 使用 raftctl request status 查询；not_found 不证明操作未执行。`);
    this.name = 'ControlTransportError';
  }
}

export const controlHelp = `raftctl — 本地协作命令（所有结果为 JSON）
  web search --query TEXT [--limit 5] [--time-range day|week|month|year] [--domains example.com,example.org]
  web fetch --url URL [--max-chars 12000]  通过 Tavily 提取公网网页正文
  skill publish --source DIR [--request-id ID]  发布/更新自己维护的共享 Skill，并为自己启用及热加载
  skill list                               查询当前 Agent 已启用的 Skills
  skill run --name NAME --script scripts/FILE [--request-id ID] -- ARGS  在当前沙箱执行脚本并记录回执
  skill catalog                            查看共享 Skill 目录
  skill reload                             重新加载当前 Query 的 Skills
  skill remove --name NAME [--request-id ID]  停用当前 Agent 的 Skill（保留共享文件）
  agent create --name NAME --system-prompt TEXT [--task TEXT] [--room ID] [--request-id ID]
  agent list                              查看自己创建的子 Agent
  agent status --id ID                     查看子 Agent 状态与最近委派结果
  agent send --id ID --task TEXT [--room ID] [--request-id ID]
  room list [--limit 20] [--cursor ID]     已加入群的目录，不含正文
  room inspect --room ID                 群状态与有界近期原文摘要
  message list [--room ID | --scope private|joined] [--unread] [--mentioned] [--after-seq N] [--limit 20] [--cursor TOKEN]
  message search --query TEXT [--room ID | --scope private|joined] [--match all|any] [--sender ID] [--since ISO] [--until ISO] [--unread] [--mentioned] [--limit 20] [--cursor TOKEN]
  message context --id ID [--before 3] [--after 3]  展开同场景邻近消息
  message get --id ID [--offset 0] [--max-chars 12000]  分段读取完整长正文
  view_inbox [--ids ID,ID] [--room ID] [--limit 20] [--request-id ID]  读取当前群新增列表并消费自己的待检查项
  inbox list [--room ID] [--after-version N] [--limit 20] [--cursor TOKEN]  共享群消息与版本；私聊返回私有通知
  inbox ack --ids ID,ID [--request-id ID]    确认私有通知；不删除共享群消息
  room changes --room ID [--cursor N]     分页查询群历史
  room silence [--room ID] [--request-id ID]  无需回复时结束当前群聊运行，不发布正文
  room send --room ID --based-on N --body TEXT [--mentions ID,ID] [--request-id ID]
  room retract --id MESSAGE_ID [--reason TEXT] [--request-id ID]  撤回自己的公开群消息
  draft resolve --id ID --action retry|revise|discard|force [--based-on N] [--body TEXT] [--contribution TEXT] [--request-id ID]
  activity report --text TEXT [--request-id ID]
  task list --room ID
  task claim --id ID --expected-version N [--request-id ID]
  task submit --id ID --expected-version N --evidence TEXT [--request-id ID]
  request status --id REQUEST_ID
所有命令支持 --json、--help；--body-file PATH 或 - 从文件/stdin 读取正文。
agent create 支持 --system-prompt-file PATH 或 -；create/send 支持 --task-file PATH 或 -。
子 Agent 自动创建独立工作目录、使用独立会话；附带 task 自动排队，结果进入父 Agent inbox。
request-id 由 CLI 自动生成，无需填写；显式传入仅用于兼容及重试已知操作。
发送前 stderr 输出 request.started，成功与错误回执携带原 ID。通信失败先 request status 查询；not_found 不证明未执行，不自动重发。
每次重新调用 CLI 是新操作；仅确定重试同一幂等操作时复用 --request-id 原ID 和原参数。脚本禁止重复启动，web 请求不提供副作用去重。
skill publish/remove 的 status 表示持久发布状态；refresh.status=loaded 才表示当前 Query 已刷新。
held 表示草稿暂存，exit 0 不代表消息已发送。`;

export async function controlCommand(argv: string[], stdin: () => Promise<string>): Promise<Command> {
  if (argv[0] === 'skill' && argv[1] === 'run') {
    const separator = argv.indexOf('--');
    const flags = argv.slice(2, separator < 0 ? undefined : separator);
    const args: Record<string, unknown> = { argv: separator < 0 ? [] : argv.slice(separator + 1) };
    let requestId: string | undefined;
    const seen = new Set<string>();
    for (let i = 0; i < flags.length; i += 2) {
      const key = flags[i]!; const value = flags[i + 1];
      if (!['--name', '--script', '--request-id'].includes(key) || !value || value.startsWith('--') || seen.has(key)) throw new Error('skill run 参数无效');
      seen.add(key);
      if (key === '--request-id') requestId = value; else args[key.slice(2)] = value;
    }
    if (!args.name || !args.script) throw new Error('skill run 需要 name 和 script');
    return { name: 'skill.run', args, requestId: requestId ?? randomUUID() };
  }
  const viewing = argv[0] === "view_inbox";
  if (viewing) argv = ["inbox", "view", ...argv.slice(1)];
  const [group, verb, ...flags] = argv; if (!group || !verb) throw new Error(controlHelp);
  if (group === "web") {
    const options = verb === "search" ? ["query", "limit", "time-range", "domains"] : verb === "fetch" ? ["url", "max-chars"] : [];
    if (!options.length) throw new Error("仅支持 web search 和 web fetch。");
    const args: Record<string, unknown> = {};
    for (let i = 0; i < flags.length; i++) {
      const flag = flags[i]!; if (flag === "--json") continue;
      if (!flag.startsWith("--") || !options.includes(flag.slice(2))) throw new Error("未知联网命令参数，请运行 raftctl --help。");
      const name = flag.slice(2).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
      const value = flags[++i];
      if (value === undefined || value.startsWith("--") || args[name] !== undefined) throw new Error("联网参数缺少值或重复。");
      args[name] = ["limit", "maxChars"].includes(name) ? Number(value) : name === "domains" ? value.split(",").map(s => s.trim()).filter(Boolean) : value;
    }
    return { name: `web.${verb}`, args };
  }
  const allowed = new Set(["room", "cursor", "ids", "based-on", "body", "body-file", "mentions", "request-id", "id", "action", "text", "expected-version", "evidence", "name", "system-prompt", "system-prompt-file", "task", "task-file", "source", "scope", "query", "match", "sender", "since", "until", "limit", "after-seq", "after-version", "before", "after", "offset", "max-chars", "unread", "mentioned", "contribution", "reason"]);
  const values: Record<string, unknown> = {};
  for (let i = 0; i < flags.length; i++) {
    const key = flags[i]!; if (key === "--json") continue;
    if (!key.startsWith("--") || !allowed.has(key.slice(2))) throw new Error(`未知选项 ${key}`);
    const name = key.slice(2).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    if (values[name] !== undefined) throw new Error(`${key} 重复`);
    if (["unread", "mentioned"].includes(name)) { values[name] = true; continue; }
    const value = flags[++i]; if (value === undefined || value.startsWith("--")) throw new Error(`${key} 缺少值`);
    values[name] = ["basedOn", "expectedVersion", "limit", "afterSeq", "afterVersion", "before", "after", "offset", "maxChars"].includes(name) ? Number(value) : ["ids", "mentions"].includes(name) ? value.split(",").filter(Boolean) : value;
  }
  const files = [["body", "bodyFile"], ["systemPrompt", "systemPromptFile"], ["task", "taskFile"]] as const;
  if (files.filter(([, file]) => values[file] === "-").length > 1) throw new Error("stdin 只能用于一个输入字段");
  for (const [field, file] of files) if (values[file] !== undefined) {
    if (values[field] !== undefined) throw new Error(`${field} 的文本和文件选项不能同时使用`);
    values[field] = values[file] === "-" ? await stdin() : await readFile(String(values[file]), "utf8"); delete values[file];
  }
  const readonly = ['inbox.list', 'room.changes', 'room.list', 'room.inspect', 'message.list', 'message.search', 'message.context', 'message.get', 'task.list', 'request.status', 'agent.list', 'agent.status', 'skill.list', 'skill.catalog'];
  const requestId = values.requestId ?? (viewing || !readonly.includes(`${group}.${verb}`) ? randomUUID() : undefined); delete values.requestId;
  return { name: viewing ? "view_inbox" : `${group}.${verb}`, args: values, ...(typeof requestId === "string" ? { requestId } : {}) };
}
export async function sendControl(command: Command, env: NodeJS.ProcessEnv): Promise<{ ok: boolean; [key: string]: unknown }> {
  const { requestId } = identifyCommand(command);
  if (!env.RAFT_SOCKET || !env.RAFT_RUN_TOKEN) throw new Error("请从 Agent 的本地 Bash 工具调用 raftctl；缺少运行身份。");
  return new Promise((resolve, reject) => {
    const connection = createConnection(env.RAFT_SOCKET!); let buffer = "";
    connection.setTimeout(command.name.startsWith("web.") ? 30_000 : 12_000, () => connection.destroy(new Error(command.name.startsWith("web.") ? "联网请求超时，已发出请求可能计费" : "连接超时")));
    connection.on("connect", () => connection.write(JSON.stringify({ token: env.RAFT_RUN_TOKEN, command }) + "\n"));
    connection.on("error", error => reject(new ControlTransportError(error.message, requestId)));
    connection.on("data", chunk => { buffer += chunk.toString(); if (buffer.length > 2_000_000) connection.destroy(new Error("响应过大")); });
    connection.on("end", () => {
      try {
        const response = JSON.parse(buffer);
        if (!response || typeof response.ok !== 'boolean' || (response.requestId !== undefined && response.requestId !== requestId)) throw new Error('响应标识不匹配');
        resolve({ ...response, requestId });
      } catch { reject(new ControlTransportError('响应不完整或标识不匹配', requestId)); }
    });
  });
}
