import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { Agent, Actor } from "../src/contracts.js";
import { Store } from "../src/store.js";
import { SkillManager } from "../src/skills.js";
import { controlCommand } from "../src/control.js";

const document = (name = "test-skill", body = "报告实际结果。", extra = "") => `---\nname: ${name}\ndescription: 在测试本地发布时使用。\n${extra}---\n${body}\n`;
function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "raft-skills-test-"));
  const db = join(dir, "raft.sqlite");
  const store = new Store(db, join(dir, "workspaces"));
  const skills = new SkillManager(store, join(dir, "skills"));
  t.after(async () => { await skills.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const agent = store.execute({ kind: "user" }, { name: "agent.create", args: { name: "A", role: "worker" }, requestId: "a" }) as Agent;
  store.transact(s => { s.agents[0]!.status = "running"; s.runs.push({ id: "run", agentId: agent.id, inputId: "i", status: "running", at: "now" }); });
  const actor: Actor = { kind: "agent", agentId: agent.id, runId: "run", channel: agent.id };
  const source = join(agent.workspace, "draft"); mkdirSync(source);
  writeFileSync(join(source, "SKILL.md"), document());
  const query = { reloadSkills: async () => ({ skills: readdirSync(join(skills.prepare(agent.id), "skills")).map(name => ({ name: `raft-local:${name}`, description: "test", argumentHint: "" })) }) };
  const exec = (name: string, args: Record<string, unknown> = {}, requestId: string = randomUUID()) => skills.execute(actor, { name, args, requestId }, () => query) as Promise<any>;
  return { dir, db, store, skills, actor, agent, source, query, exec };
}
test("Skill 发布复制脚本，幂等重试不偷换草稿内容；更新及移除只影响当前成员", async t => {
  const { store, skills, agent, source, exec } = fixture(t);
  mkdirSync(join(source, "scripts")); writeFileSync(join(source, "scripts", "run.mjs"), "console.log(42)");
  const first = await exec("skill.publish", { source: "draft" }, "first");
  assert.equal(first.refresh.status, "loaded"); assert.equal(first.active, true);
  assert.equal(readFileSync(join(first.directory, "scripts", "run.mjs"), "utf8"), "console.log(42)");
  writeFileSync(join(source, "SKILL.md"), document("test-skill", "第二版说明"));
  const retry = await exec("skill.publish", { source: "draft" }, "first");
  assert.equal(retry.version, first.version); assert.equal(store.state.publishedSkills!.length, 1);
  await assert.rejects(exec("skill.remove", { name: "test-skill" }, "first"), /不同内容/);
  const next = await exec("skill.publish", { source: "draft" });
  assert.notEqual(next.version, first.version);
  assert.equal((await exec("skill.publish", { source: "draft" }, "first")).active, false);
  const other = store.execute({ kind: "user" }, { name: "agent.create", args: { name: "B", role: "worker" }, requestId: "b" }) as Agent;
  assert.deepEqual(readdirSync(join(skills.prepare(other.id), "skills")), []);
  const removed = await exec("skill.remove", { name: "test-skill" });
  assert.equal(removed.status, "removed"); assert.deepEqual(removed.refresh.skills, []);
  assert.equal((await exec("skill.list")).skills.length, 0);
  assert.match(readFileSync(join(first.directory, "SKILL.md"), "utf8"), /报告实际结果/);
  assert.equal(store.state.agents.find(a => a.id === agent.id)!.status, "running");
});
test("发布校验拒绝越界来源、符号链接、权限 frontmatter 和内联执行，不污染登记", async t => {
  const { store, source, agent, exec } = fixture(t);
  await assert.rejects(exec("skill.publish", { source: "../" }), /工作目录/);
  symlinkSync(source, join(agent.workspace, "linked"));
  await assert.rejects(exec("skill.publish", { source: "linked" }), /符号链接/);
  writeFileSync(join(source, "SKILL.md"), document("test-skill", "body", "allowed-tools: Bash\n"));
  await assert.rejects(exec("skill.publish", { source }), /权限/);
  writeFileSync(join(source, "SKILL.md"), document("test-skill", "!`echo hi`"));
  await assert.rejects(exec("skill.publish", { source }), /内联/);
  writeFileSync(join(source, "SKILL.md"), document());
  symlinkSync("/etc/hosts", join(source, "references"));
  await assert.rejects(exec("skill.publish", { source }), /符号链接/);
  assert.equal(store.state.publishedSkills?.length ?? 0, 0);
});
test("刷新失败保留发布事实，原请求可重试；停止的运行不能管理 Skill", async t => {
  const { store, actor, skills, exec } = fixture(t);
  const command = { name: "skill.publish", args: { source: "draft" }, requestId: "pending" };
  const pending = await skills.execute(actor, command, () => ({ reloadSkills: async () => { throw new Error("SDK 暂不可用"); } })) as any;
  assert.equal(pending.status, "published"); assert.equal(pending.refresh.status, "pending");
  const receipt = store.execute(actor, { name: "request.status", args: { id: "pending" } }) as any;
  assert.equal(receipt.version, pending.version);
  const retry = await exec("skill.publish", { source: "draft" }, "pending");
  assert.equal(retry.version, pending.version); assert.equal(retry.refresh.status, "loaded");
  store.transact(s => { s.agents[0]!.status = "stopped"; });
  assert.throws(() => skills.execute(actor, { name: "skill.list", args: {} }, () => undefined), /停止/);
});
test("持久登记恢复 Skill 投影；无关 Agent 的插件目录保持独立", async t => {
  const { store, skills, dir, db, agent, exec } = fixture(t);
  const published = await exec("skill.publish", { source: "draft" });
  const plugin = skills.prepare(agent.id);
  rmSync(join(plugin, "skills", "test-skill"));
  const reopened = new Store(db, join(dir, "workspaces"));
  try {
    const restored = new SkillManager(reopened, join(dir, "skills"));
    const path = restored.prepare(agent.id);
    assert.equal(readFileSync(join(path, "skills", "test-skill", "SKILL.md"), "utf8"), readFileSync(join(published.directory, "SKILL.md"), "utf8"));
    assert.equal(reopened.state.publishedSkills!.length, store.state.publishedSkills!.length);
  } finally { reopened.close(); }
});
test("Skill CLI 参数传递本地路径，不解释为 shell", async () => {
  const command = await controlCommand(["skill", "publish", "--source", "draft with spaces", "--request-id", "id", "--json"], async () => "");
  assert.deepEqual(command, { name: "skill.publish", args: { source: "draft with spaces" }, requestId: "id" });
});
