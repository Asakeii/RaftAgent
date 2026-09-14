import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { ModelSettings } from "../src/model-settings.js";
import { startService } from "../src/server.js";
import type { Agent } from "../src/contracts.js";

test("模型设置持久保存，Key 不回显；留空保留、明确清除，环境配置不被改写", t => {
  const dir = mkdtempSync(join(tmpdir(), "raft-model-settings-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ANTHROPIC_API_KEY: "environment-key", PATH: "/test-bin" };
  const settings = new ModelSettings(dir, env);
  assert.equal(settings.view().source, "environment"); assert.equal(settings.view().hasApiKey, true);
  const saved = settings.save({ baseUrl: "https://example.com/compatible/", model: " model-a ", apiKey: "new-key" });
  assert.deepEqual(saved, { baseUrl: "https://example.com/compatible", model: "model-a", hasApiKey: true, source: "saved" });
  assert.equal(statSync(settings.path).mode & 0o777, 0o600);
  assert.equal(env.ANTHROPIC_API_KEY, "environment-key");
  settings.save({ baseUrl: saved.baseUrl, model: "model-b", apiKey: "" });
  assert.equal(settings.env.ANTHROPIC_API_KEY, "new-key");
  const reopened = new ModelSettings(dir, env);
  assert.equal(reopened.env.ANTHROPIC_API_KEY, "new-key"); assert.equal(reopened.env.ANTHROPIC_MODEL, "model-b");
  assert.equal(reopened.env.PATH, env.PATH);
  reopened.save({ baseUrl: saved.baseUrl, model: "", clearApiKey: true });
  assert.equal(new ModelSettings(dir, env).view().hasApiKey, false);
  assert.ok(!JSON.stringify(saved).includes("new-key"));
});

test("无效配置、换端点未重新填写 Key 均拒绝，磁盘与运行配置保持原值", t => {
  const dir = mkdtempSync(join(tmpdir(), "raft-model-invalid-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const settings = new ModelSettings(dir, {});
  settings.save({ baseUrl: "https://example.com", model: "m", apiKey: "original-key" });
  const original = readFileSync(settings.path, "utf8");
  for (const change of [
    { baseUrl: "file:///tmp/api", model: "m" },
    { baseUrl: "https://example.com/v1/messages", model: "m" },
    { baseUrl: "https://ark.cn-beijing.volces.com/api/compatible", model: "", apiKey: "new-key" },
    { baseUrl: "https://another.example", model: "m" },
    { baseUrl: "https://example.com", model: "m", apiKey: "bad\nkey" },
    { baseUrl: "https://example.com", model: "m", apiKey: "new", clearApiKey: true },
  ]) assert.throws(() => settings.save(change));
  assert.equal(readFileSync(settings.path, "utf8"), original);
  assert.equal(settings.env.ANTHROPIC_API_KEY, "original-key");
});

test("设置 API 要求用户凭据；保存不启动模型，下一轮使用新配置且不影响当前轮", async t => {
  const dir = mkdtempSync(join(tmpdir(), "raft-model-service-"));
  const seen: Options[] = []; const finish: (() => void)[] = [];
  const service = await startService(resolve("."), dir, {}, async (_prompt, options) => {
    seen.push(options);
    await new Promise<void>(r => { finish.push(r); options.abortController!.signal.addEventListener("abort", () => r(), { once: true }); });
  });
  let reopened: Awaited<ReturnType<typeof startService>> | undefined;
  t.after(async () => { await service.close(); await reopened?.close(); rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${service.port}`;
  const headers = { Authorization: `Bearer ${service.token}`, "Content-Type": "application/json" };
  const save = (data: unknown) => fetch(base + "/api/settings", { method: "POST", headers, body: JSON.stringify(data) });
  assert.equal((await fetch(base + "/api/settings")).status, 401);
  assert.equal((await fetch(base + "/api/settings", { method: "POST", body: "{}" })).status, 401);
  const command = (name: string, args: Record<string, unknown>) => service.store.execute({ kind: "user" }, { name, args, requestId: randomUUID() });
  const agent = command("agent.create", { name: "A", role: "test" }) as Agent;
  command("direct.send", { agentId: agent.id, text: "first" });
  await new Promise(r => setTimeout(r, 20)); assert.equal(seen.length, 0);
  const response = await save({ baseUrl: "https://example.com", model: "model-a", apiKey: "key-a" });
  assert.equal(response.status, 200); assert.ok(!(await response.text()).includes("key-a"));
  await new Promise(r => setTimeout(r, 20)); assert.equal(seen.length, 0);
  command("direct.send", { agentId: agent.id, text: "second" });
  const waitFor = async (check: () => boolean) => { for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error("未完成配置切换验证"); };
  await waitFor(() => seen.length === 1);
  assert.equal(seen[0]!.model, "model-a"); assert.equal(seen[0]!.env!.ANTHROPIC_API_KEY, "key-a");
  await save({ baseUrl: "https://example.com", model: "model-b", apiKey: "key-b" });
  assert.equal(seen[0]!.env!.ANTHROPIC_API_KEY, "key-a");
  finish[0]!(); await waitFor(() => seen.length === 2);
  assert.equal(seen[1]!.model, "model-b"); assert.equal(seen[1]!.env!.ANTHROPIC_API_KEY, "key-b");
  finish[1]!(); await waitFor(() => service.scheduler.active.size === 0);
  const snapshot = await fetch(base + "/api/state", { headers }).then(r => r.text());
  assert.ok(!snapshot.includes("key-a") && !snapshot.includes("key-b"));
  const invalid = await fetch(base + "/api/settings", { method: "POST", headers, body: '{"apiKey":"secret-value", broken' });
  assert.equal(invalid.status, 400); assert.ok(!(await invalid.text()).includes("secret-value"));
  await service.close();
  reopened = await startService(resolve("."), dir, {});
  assert.equal(reopened.scheduler.env.ANTHROPIC_MODEL, "model-b");
  assert.equal(reopened.scheduler.env.ANTHROPIC_API_KEY, "key-b");
});
