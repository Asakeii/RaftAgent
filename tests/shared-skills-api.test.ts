import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { startService } from "../src/server.js";
import type { Agent } from "../src/contracts.js";

test("共享 Skills API 鉴权、配置幂等与重启恢复；默认启用内置能力", async t => {
  const dir = await mkdtemp(join(tmpdir(), "raft-shared-api-"));
  let service = await startService(resolve("."), dir, {});
  t.after(async () => { await service.close(); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${service.port}`;
  assert.equal((await fetch(base + "/api/skills")).status, 401);
  const headers = { Authorization: `Bearer ${service.token}`, "Content-Type": "application/json" };
  const agent = service.store.execute({ kind: "user" }, { name: "agent.create", args: { name: "A", role: "test" }, requestId: "create" }) as Agent;
  assert.equal(service.skills.enabledIds(agent.id).length, 2);
  const catalog = await fetch(base + "/api/skills", { headers }).then(r => r.json());
  assert.equal(catalog.skills.length, 2); assert.ok(catalog.skills.every((s: { source: string }) => s.source.startsWith(join(dir, "skills", "sources"))));
  const data = { name: "skill.configure", args: { agentId: agent.id, ids: [] }, requestId: "configure" };
  const configure = (value: unknown) => fetch(base + "/api/command", { method: "POST", headers, body: JSON.stringify(value) });
  assert.equal((await configure(data)).status, 200);
  assert.equal((await configure(data)).status, 200);
  assert.equal((await configure({ ...data, args: { agentId: agent.id, ids: [catalog.skills[0].id] } })).status, 400);
  assert.equal(service.store.state.runs.length, 0);
  await service.close(); service = await startService(resolve("."), dir, {});
  assert.deepEqual(service.skills.enabledIds(agent.id), []);
  assert.equal(service.skills.catalogView().length, 2);
});
