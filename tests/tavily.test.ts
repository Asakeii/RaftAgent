import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readTavilyKey, TavilyService } from "../src/tavily.js";
import { controlCommand, sendControl } from "../src/control.js";
import { startService } from "../src/server.js";
import type { Agent } from "../src/contracts.js";

test("Tavily CLI 参数与搜索请求映射，限制输出、脱敏 Key，提取明确标记截断", async () => {
  const calls: { url: string; body: any; headers: any }[] = [];
  const service = new TavilyService(() => "test-tavily-secret", async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)), headers: init?.headers });
    return Response.json({ request_id: "r1", usage: { credits: 1 }, results: [{ url: "https://example.com/doc", title: "source", content: "test-tavily-secret content", raw_content: "test-tavily-secret content" }, { url: "file:///private/doc", content: "ignore" }] });
  });
  const command = await controlCommand(["web", "search", "--query", "SDK docs $(echo safe)", "--limit", "2", "--domains", "example.com,nodejs.org", "--time-range", "month", "--json"], async () => "");
  const result = await service.execute(command, new AbortController().signal) as any;
  assert.equal(calls[0]!.url, "https://api.tavily.com/search");
  assert.equal(calls[0]!.headers.Authorization, "Bearer test-tavily-secret");
  assert.deepEqual(calls[0]!.body.include_domains, ["example.com", "nodejs.org"]);
  assert.equal(calls[0]!.body.query, "SDK docs $(echo safe)");
  assert.equal(calls[0]!.body.search_depth, "basic"); assert.equal(calls[0]!.body.auto_parameters, false);
  assert.equal(result.results.length, 1); assert.equal(result.credits, 1);
  assert.ok(!JSON.stringify(result).includes("test-tavily-secret"));
  const extracted = await service.execute({ name: "web.fetch", args: { url: "https://example.com/doc", maxChars: 5 } }, new AbortController().signal) as any;
  assert.equal(calls[1]!.url, "https://api.tavily.com/extract");
  assert.equal(extracted.results[0].content.length, 5); assert.equal(extracted.results[0].truncated, true);
});

test("无效参数、本地 URL、停止请求不访问供应商，失败响应不泄露请求或 Key", async () => {
  let calls = 0;
  const service = new TavilyService(() => "secret", async () => { calls++; return new Response("secret", { status: 401 }); });
  for (const command of [
    { name: "web.search", args: { query: "hello", limit: 100 } },
    { name: "web.search", args: { query: "hello", domains: ["https://example.com"] } },
    { name: "web.search", args: { query: "hello", timeRange: "all" } },
    { name: "web.search", args: { query: "hello", apiKey: "secret" } },
    { name: "web.fetch", args: { url: "http://127.0.0.1" } },
    { name: "web.fetch", args: { url: "http://localhost/private" } },
    { name: "web.fetch", args: { url: "https://name:password@example.com" } },
    { name: "web.unknown", args: {} },
  ]) await assert.rejects(service.execute(command, new AbortController().signal));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(service.execute({ name: "web.search", args: { query: "hello" } }, controller.signal));
  assert.equal(calls, 0);
  await assert.rejects(service.execute({ name: "web.search", args: { query: "hello" } }, new AbortController().signal), e => e instanceof Error && e.message.includes("401") && !e.message.includes("secret"));
  assert.equal(calls, 1);
  await assert.rejects(controlCommand(["web", "search", "--api-key", "secret"], async () => ""));
  await assert.rejects(controlCommand(["web", "search", "--limit", "2", "--limit", "3"], async () => ""));
});

test("搜索停止后取消在途请求并释放并发名额；正文提取失败不伪装成功", async () => {
  let cancel = false;
  const service = new TavilyService(() => "key", async (_url, init) => {
    await new Promise<void>((_r, reject) => init?.signal?.addEventListener("abort", () => { cancel = true; reject(new Error("aborted")); }, { once: true }));
    return Response.json({ results: [] });
  });
  const controller = new AbortController();
  const pending = service.execute({ name: "web.search", args: { query: "q" } }, controller.signal);
  controller.abort(); await assert.rejects(pending, /已取消/); assert.equal(cancel, true);
  const extract = new TavilyService(() => "key", async () => Response.json({ results: [], failed_results: [{ error: "private upstream details" }] }));
  await assert.rejects(extract.execute({ name: "web.fetch", args: { url: "https://example.com" } }, new AbortController().signal), /未能提取/);
});

test("Tavily 配置覆盖环境且可随请求重新读取，CLI 校验运行身份，Key 不传给 SDK", async t => {
  const dir = mkdtempSync(join(tmpdir(), "raft-tavily-test-"));
  let service: Awaited<ReturnType<typeof startService>> | undefined;
  t.after(async () => { await service?.close(); rmSync(dir, { recursive: true, force: true }); });
  assert.equal(readTavilyKey(dir, { TAVILY_API_KEY: "env-key" }), "env-key");
  writeFileSync(join(dir, "tavily-settings.json"), JSON.stringify({ version: 1, apiKey: "saved-key" }), { mode: 0o600 });
  assert.equal(readTavilyKey(dir, { TAVILY_API_KEY: "env-key" }), "saved-key");
  service = await startService(resolve("."), dir, { ANTHROPIC_API_KEY: "fake", TAVILY_API_KEY: "env-key" }, async (_prompt, options) => {
    assert.equal(options.env?.TAVILY_API_KEY, undefined);
    await new Promise<void>(r => options.abortController!.signal.addEventListener("abort", () => r(), { once: true }));
  });
  const agent = service.store.execute({ kind: "user" }, { name: "agent.create", args: { name: "Probe", role: "test" }, requestId: "create" }) as Agent;
  service.store.execute({ kind: "user" }, { name: "direct.send", args: { agentId: agent.id, text: "test" }, requestId: "send" });
  await new Promise(r => setTimeout(r, 20));
  const token = [...service.scheduler.tokens.keys()][0]!; assert.ok(token);
  const command = { name: "web.search", args: { query: "test", limit: 999 } };
  const valid = await sendControl(command, { RAFT_SOCKET: service.socket, RAFT_RUN_TOKEN: token });
  assert.equal(valid.ok, false); assert.match(String(valid.error), /整数/);
  const invalid = await sendControl(command, { RAFT_SOCKET: service.socket, RAFT_RUN_TOKEN: "invalid" });
  assert.equal(invalid.ok, false); assert.match(String(invalid.error), /无有效运行身份/);
});
