import { createServer as httpServer, type IncomingMessage } from "node:http";
import { createServer as netServer } from "node:net";
import { mkdir, chmod, readFile, writeFile, unlink } from "node:fs/promises";
import { join, resolve, extname } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Store, DomainError } from "./store.js";
import { Scheduler, type SessionRunner } from "./runtime.js";
import type { Command, Snapshot } from "./contracts.js";
import { SkillManager } from "./skills.js";
import { ModelSettings } from "./model-settings.js";
import { TavilyService, readTavilyKey } from "./tavily.js";
import { TraceStore } from "./trace.js";
import { readHistory, type HistoryReader } from "./history.js";

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
async function body(req: IncomingMessage): Promise<unknown> {
  let text = "";
  for await (const chunk of req) { text += String(chunk); if (Buffer.byteLength(text) > 200_000) throw new DomainError("请求过大"); }
  try { return JSON.parse(text || "{}"); } catch { throw new DomainError("请求不是有效的 JSON。"); }
}
export function parseCommand(value: unknown): Command {
  if (!value || typeof value !== "object") throw new DomainError("命令格式无效");
  const x = value as Record<string, unknown>;
  if (typeof x.name !== "string" || !x.args || typeof x.args !== "object" || Array.isArray(x.args)) throw new DomainError("命令格式无效");
  if (x.requestId !== undefined && (typeof x.requestId !== "string" || x.requestId.length > 150)) throw new DomainError("requestId 无效");
  return { name: x.name, args: x.args as Record<string, unknown>, ...(typeof x.requestId === "string" ? { requestId: x.requestId } : {}) };
}
export async function startService(root: string, dataDir: string, env: NodeJS.ProcessEnv, runner?: SessionRunner, historyReader?: HistoryReader) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const modelSettings = new ModelSettings(dataDir, env);
  const runtimeEnv = modelSettings.env;
  // 搜索 Key 仅供宿主读取，不注入模型/工具子进程环境。
  delete runtimeEnv.TAVILY_API_KEY;
  const web = new TavilyService(() => readTavilyKey(dataDir, env));
  const lockPath = join(dataDir, "service.lock");
  let lock;
  try { const { open } = await import("node:fs/promises"); lock = await open(lockPath, "wx", 0o600); }
  catch { throw new Error(`数据目录已被占用或上次未正常关闭：${lockPath}。核实旧服务和工具进程已停止后移除此锁，再启动。`); }
  await lock.writeFile(String(process.pid)); await lock.close();
  const bin = join(dataDir, "bin"); await mkdir(bin, { recursive: true });
  const script = `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(root, "dist/cli.js"))} ctl "$@"\n`;
  await writeFile(join(bin, "raftctl"), script, { mode: 0o700 }); await chmod(join(bin, "raftctl"), 0o700);
  const store = new Store(join(dataDir, "raft.sqlite"), resolve(dataDir, "workspaces")); store.recover();
  const socket = join(tmpdir(), `raft-${randomUUID().slice(0, 12)}.sock`);
  const skills = new SkillManager(store, resolve(dataDir, "skills"));
  const traces = new TraceStore(join(dataDir, 'traces.sqlite'));
  const scheduler = new Scheduler(store, runtimeEnv, socket, root, bin, runner, skills, traces);
  const subscribers = new Set<import("node:http").ServerResponse>();
  let closing = false;
  traces.changed = () => { if (!closing) for (const response of subscribers) response.write('data: trace\n\n'); };
  const snapshot = (): Snapshot => {
    const s = store.state;
    // 内部幂等载荷、待执行输入等不进入通用 UI 投影。
    return { state: { ...s, requests: {}, inputs: [], notices: {} }, approvals: [...scheduler.approvals.values()].map(x => x.value), ready: Boolean(runtimeEnv.ANTHROPIC_API_KEY?.trim()), model: runtimeEnv.ANTHROPIC_MODEL || "SDK 默认模型", dataDir };
  };
  store.changed = () => {
    if (closing) return;
    for (const response of subscribers) response.write(`data: ${store.state.seq}\n\n`);
    scheduler.wake();
  };
  const ipc = netServer(connection => {
    connection.setTimeout(15_000, () => connection.destroy()); let buffer = ""; let handled = false;
    connection.on("error", () => {});
    connection.on("data", async chunk => {
      buffer += chunk.toString();
      if (Buffer.byteLength(buffer) > 200_000) { connection.destroy(); return; }
      if (handled || !buffer.includes("\n")) return; handled = true;
      try {
        const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n"))) as { token: string; command: unknown };
        const actor = scheduler.tokens.get(request.token);
        if (!actor || closing) throw new DomainError("无有效运行身份或服务正在关闭");
        const command = parseCommand(request.command);
        let data: unknown;
        if (command.name.startsWith("web.")) {
          const running = actor.kind === "agent" ? scheduler.active.get(actor.agentId) : undefined;
          if (!running || running.controller.signal.aborted) throw new DomainError("联网命令需要活动 Agent 运行身份。");
          connection.setTimeout(35_000);
          const disconnected = new AbortController();
          const disconnect = () => disconnected.abort();
          connection.once("close", disconnect);
          try { data = await web.execute(command, AbortSignal.any([running.controller.signal, disconnected.signal])); }
          finally { connection.off("close", disconnect); }
        } else if (command.name.startsWith("skill.")) {
          data = await skills.execute(actor, command, () => scheduler.tokens.get(request.token) === actor && actor.kind === "agent" ? scheduler.active.get(actor.agentId)?.query : undefined);
        } else data = store.execute(actor, command);
        connection.end(JSON.stringify({ schemaVersion: 1, ok: true, requestId: command.requestId, data }) + "\n");
      } catch (error) { connection.end(JSON.stringify({ schemaVersion: 1, ok: false, error: error instanceof Error ? error.message : String(error) }) + "\n"); }
    });
  });
  await new Promise<void>((res, rej) => { ipc.once("error", rej); ipc.listen(socket, res); }); await chmod(socket, 0o600);
  const token = randomUUID();
  const http = httpServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    const json = (code: number, value: unknown) => { res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(value)); };
    try {
      if (url.pathname.startsWith("/api/")) {
        if (req.headers.authorization !== `Bearer ${token}`) { json(401, { error: "未授权" }); return; }
        if (closing) { json(503, { error: "服务正在退出" }); return; }
        const inspect = url.pathname.match(/^\/api\/agents\/([^/]+)\/(history|traces)(?:\/([^/]+))?$/);
        if (inspect && req.method === 'GET') {
          const agent = store.state.agents.find(a => a.id === inspect[1]);
          if (!agent) { json(404, { error: 'Agent 不存在。' }); return; }
          const number = (key: string, fallback: number, max: number) => {
            const raw = url.searchParams.get(key); const value = raw === null ? fallback : Number(raw);
            if (!Number.isSafeInteger(value) || value < 0 || value > max || (key === 'limit' && value === 0)) throw new DomainError('分页参数无效。');
            return value;
          };
          if (inspect[2] === 'history' && !inspect[3]) {
            const known = traces.sessions(agent.id);
            const sessions = [...new Set([...(agent.sessionId ? [agent.sessionId] : []), ...known.sessions])];
            const sessionId = url.searchParams.get('sessionId') || agent.sessionId || sessions[0] || null;
            try {
              const page = await readHistory({ sessionId, sessions, workspace: agent.workspace, limit: number('limit', 40, 100),
                ...(url.searchParams.get('before') ? { before: url.searchParams.get('before')! } : {}),
                secrets: [runtimeEnv.ANTHROPIC_API_KEY ?? '', runtimeEnv.ANTHROPIC_AUTH_TOKEN ?? '', token], runInputs: known.runInputs,
                ...(historyReader ? { reader: historyReader } : {}) });
              json(200, page);
            } catch (error) { if (error instanceof DomainError) throw error; throw new Error('无法读取 SDK 会话记录，请刷新重试。'); }
            return;
          }
          if (inspect[2] === 'traces' && inspect[3]) {
            const run = traces.get(inspect[3]);
            if (!run || run.agentId !== agent.id) { json(404, { error: '执行记录不存在。' }); return; }
            json(200, { run, ...traces.events(run.id, number('after', 0, Number.MAX_SAFE_INTEGER)),
              related: traces.related(run.traceId).map(r => ({ id: r.id, agentId: r.agentId, status: r.status })), warning: traces.warning }); return;
          }
          if (inspect[2] === 'traces') {
            json(200, { ...traces.list(agent.id, url.searchParams.get('before') || undefined), pending: store.state.inputs.filter(i => i.agentId === agent.id && i.status === 'pending').length,
              agentStatus: agent.status, ready: !!runtimeEnv.ANTHROPIC_API_KEY?.trim(), warning: traces.warning,
              legacyRuns: store.state.runs.filter(r => r.agentId === agent.id && !traces.get(r.id)).length }); return;
          }
          json(404, { error: '接口不存在' }); return;
        }
        if (url.pathname === "/api/settings" && req.method === "GET") { json(200, modelSettings.view()); return; }
        if (url.pathname === "/api/settings" && req.method === "POST") {
          const settings = modelSettings.save(await body(req));
          // 通知界面，但保存配置本身不唤醒此前排队的任务。
          for (const response of subscribers) response.write(`data: settings\n\n`);
          json(200, settings); return;
        }
        if (url.pathname === "/api/state" && req.method === "GET") { json(200, snapshot()); return; }
        if (url.pathname === "/api/events" && req.method === "GET") {
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" }); res.write("data: ready\n\n"); subscribers.add(res); req.on("close", () => subscribers.delete(res)); return;
        }
        if (url.pathname === "/api/command" && req.method === "POST") {
          const command = parseCommand(await body(req));
          const result = store.execute({ kind: "user" }, command);
          if (command.name === "agent.stop") scheduler.stop(String(command.args.id));
          json(200, { ok: true, data: result }); return;
        }
        if (url.pathname === "/api/approval" && req.method === "POST") {
          const value = await body(req) as { id: string; allow: boolean }; const item = scheduler.approvals.get(value.id);
          if (!item || typeof value.allow !== "boolean") throw new DomainError("权限请求已失效");
          item.resolve(value.allow); json(200, { ok: true }); return;
        }
        json(404, { error: "接口不存在" }); return;
      }
      if (req.method !== "GET") { json(405, { error: "仅支持 GET" }); return; }
      const path = url.pathname === "/" ? "/index.html" : url.pathname;
      const file = resolve(root, "dist-ui", `.${decodeURIComponent(path)}`);
      if (!file.startsWith(resolve(root, "dist-ui") + "/")) { json(403, { error: "无效路径" }); return; }
      const content = await readFile(file);
      const mime: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
      res.writeHead(200, { "Content-Type": mime[extname(file)] || "application/octet-stream", "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'", "X-Content-Type-Options": "nosniff" }); res.end(content);
    } catch (error) { json(error instanceof DomainError ? 400 : 500, { error: error instanceof Error ? error.message : String(error) }); }
  });
  await new Promise<void>(res => http.listen(0, "127.0.0.1", res));
  const address = http.address() as import("node:net").AddressInfo;
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => closePromise ??= (async () => {
    closing = true;
    for (const client of subscribers) client.end(); subscribers.clear();
    await scheduler.close();
    await skills.close();
    await Promise.all([new Promise<void>(r => http.close(() => r())), new Promise<void>(r => ipc.close(() => r()))]);
    traces.close(); store.close(); await unlink(socket).catch(() => {}); await unlink(lockPath);
  })();
  return { url: `http://127.0.0.1:${address.port}/#${token}`, token, port: address.port, store, scheduler, skills, traces, socket, close };
}
