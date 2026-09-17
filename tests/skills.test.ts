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
  assert.equal(retry.version, first.version); assert.equal(store.state.skillCatalog!.length, 1);
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
  assert.equal(store.state.skillCatalog?.length ?? 0, 0);
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
    assert.equal(reopened.state.skillCatalog!.length, store.state.skillCatalog!.length);
  } finally { reopened.close(); }
});
test("Skill CLI 参数传递本地路径，不解释为 shell", async () => {
  const command = await controlCommand(["skill", "publish", "--source", "draft with spaces", "--request-id", "id", "--json"], async () => "");
  assert.deepEqual(command, { name: "skill.publish", args: { source: "draft with spaces" }, requestId: "id" });
});

test("共享 Skill 按配置复用同一版本，使用者不能覆盖维护者，停用不删除共享库", async t => {
  const { store, skills, agent, source, exec } = fixture(t);
  const first = await exec("skill.publish", { source: "draft" });
  const other = store.execute({ kind: "user" }, { name: "agent.create", args: { name: "B", role: "worker" }, requestId: "b" }) as Agent;
  const configure = (ids: string[], requestId = randomUUID()) => skills.execute({ kind: "user" }, { name: "skill.configure", args: { agentId: other.id, ids }, requestId }, () => undefined);
  await configure([first.id]);
  const projected = join(skills.prepare(other.id), "skills", "test-skill", "SKILL.md");
  assert.equal(readFileSync(projected, "utf8"), readFileSync(join(first.directory, "SKILL.md"), "utf8"));
  store.transact(s => { s.agents.find(a => a.id === other.id)!.status = "running"; s.runs.push({ id: "other-run", agentId: other.id, inputId: "other", status: "running", at: "now" }); });
  const otherActor: Actor = { kind: "agent", agentId: other.id, runId: "other-run", channel: other.id };
  mkdirSync(join(other.workspace, "draft")); writeFileSync(join(other.workspace, "draft", "SKILL.md"), document());
  await assert.rejects(skills.execute(otherActor, { name: "skill.publish", args: { source: "draft" }, requestId: "overwrite" }, () => undefined), /维护者/);
  await assert.rejects(skills.execute(otherActor, { name: "skill.configure", args: { agentId: agent.id, ids: [] }, requestId: "configure" }, () => undefined), /仅用户/);
  await assert.rejects(configure(["missing"]), /未知/);
  await assert.rejects(configure([first.id, first.id]), /重复/);
  writeFileSync(join(source, "SKILL.md"), document("test-skill", "新共享版本"));
  const next = await exec("skill.publish", { source: "draft" });
  assert.match(readFileSync(projected, "utf8"), /报告实际结果/); // Existing run keeps its view until prepare/reload.
  skills.prepare(other.id);
  assert.match(readFileSync(projected, "utf8"), /新共享版本/);
  assert.equal(store.state.skillCatalog!.length, 1);
  await exec("skill.remove", { name: "test-skill" });
  assert.equal(skills.catalogView()[0]!.version, next.version);
  assert.deepEqual(skills.enabledIds(other.id), [first.id]);
  await configure([]); skills.prepare(other.id);
  assert.deepEqual(readdirSync(join(skills.prepare(other.id), "skills")), []);
});

test("用户从总目录发布修改：版本不可变，源码重命名及符号链接被拒绝", async t => {
  const { skills, exec } = fixture(t);
  const first = await exec("skill.publish", { source: "draft" });
  writeFileSync(join(first.source, "SKILL.md"), document("test-skill", "统一目录修改"));
  const publish = () => skills.execute({ kind: "user" }, { name: "skill.publish", args: { id: first.id }, requestId: randomUUID() }, () => undefined) as Promise<any>;
  const next = await publish();
  assert.notEqual(next.version, first.version); assert.equal(next.refresh.status, "next-run");
  assert.match(readFileSync(join(first.directory, "SKILL.md"), "utf8"), /报告实际结果/);
  writeFileSync(join(first.source, "SKILL.md"), document("renamed"));
  await assert.rejects(publish(), /名称/);
  rmSync(first.source, { recursive: true }); symlinkSync(first.directory, first.source);
  await assert.rejects(publish(), /符号链接/);
});

test("旧目录迁移可重启、同名不同来源不互相覆盖、保留原文件和 Agent 配置", async t => {
  const dir = mkdtempSync(join(tmpdir(), "raft-skills-migrate-"));
  const store = new Store(join(dir, "raft.sqlite"), join(dir, "workspaces"));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const agents = ["A", "B"].map(name => store.execute({ kind: "user" }, { name: "agent.create", args: { name, role: "test" }, requestId: name }) as Agent);
  for (const a of agents) {
    const folder = join(dir, "skills", a.id, "releases", "old-version"); mkdirSync(folder, { recursive: true }); writeFileSync(join(folder, "SKILL.md"), document("same", a.name));
  }
  store.transact(s => { for (const a of s.agents) delete a.skillIds; s.publishedSkills = agents.map(a => ({ agentId: a.id, name: "same", description: "old", version: "old-version", publishedAt: "before" })); });
  const skills = new SkillManager(store, join(dir, "skills"));
  assert.equal(skills.catalogView().length, 2);
  for (const a of agents) {
    assert.match(readFileSync(join(skills.prepare(a.id), "skills", "same", "SKILL.md"), "utf8"), new RegExp(a.name));
    assert.ok(readFileSync(join(dir, "skills", a.id, "releases", "old-version", "SKILL.md"), "utf8"));
  }
  assert.notDeepEqual(skills.enabledIds(agents[0]!.id), skills.enabledIds(agents[1]!.id));
  await assert.rejects(skills.execute({ kind: "user" }, { name: "skill.configure", args: { agentId: agents[0]!.id, ids: skills.catalogView().map(s => s.id) }, requestId: "both" }, () => undefined), /同名/);
  const author = agents[0]!;
  const otherId = skills.enabledIds(agents[1]!.id)[0]!;
  await skills.execute({ kind: "user" }, { name: "skill.configure", args: { agentId: author.id, ids: [otherId] }, requestId: "switch-source" }, () => undefined);
  store.transact(s => { s.agents[0]!.status = "running"; s.runs.push({ id: "run", agentId: author.id, inputId: "none", status: "running", at: "now" }); });
  mkdirSync(join(author.workspace, "draft")); writeFileSync(join(author.workspace, "draft", "SKILL.md"), document("same", "new"));
  await assert.rejects(skills.execute({ kind: "agent", agentId: author.id, runId: "run", channel: author.id }, { name: "skill.publish", args: { source: "draft" }, requestId: "conflict" }, () => undefined), /同名/);
  const reopened = new SkillManager(store, join(dir, "skills"));
  assert.equal(reopened.catalogView().length, 2); assert.equal(store.state.skillCatalogVersion, 1);
});
