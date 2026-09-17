import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, symlinkSync, unlinkSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parseDocument } from "yaml";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import type { Actor, Command, SharedSkill } from "./contracts.js";
import { DomainError, required, Store } from "./store.js";

type AgentActor = Extract<Actor, { kind: "agent" }>;
type SkillQuery = Pick<Query, "reloadSkills">;
type BundleFile = { path: string; bytes: Buffer; executable: boolean };
const validName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Shared source/release storage; SDK still owns discovery, execution and reload. */
export class SkillManager {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly store: Store, readonly directory: string, builtinDirectory?: string) {
    this.migrate(builtinDirectory);
  }
  private agent(id: string) {
    const agent = this.store.state.agents.find(a => a.id === id);
    if (!agent) throw new DomainError("Agent 不存在");
    return agent;
  }
  private catalog() { return this.store.state.skillCatalog ?? []; }
  enabledIds(agentId: string) { return this.agent(agentId).skillIds ?? this.catalog().filter(s => s.plugin === "raft").map(s => s.id); }
  private records(agentId: string, plugin?: SharedSkill["plugin"]) {
    const ids = this.enabledIds(agentId);
    return this.catalog().filter(s => ids.includes(s.id) && (!plugin || s.plugin === plugin));
  }
  private release(skill: SharedSkill) { return resolve(this.directory, "releases", skill.id, skill.version); }
  private source(id: string) { return resolve(this.directory, "sources", id); }
  catalogView() { return this.catalog().map(s => ({ ...s, skill: `${s.plugin}:${s.name}`, directory: this.release(s), source: this.source(s.id) })); }
  private writeFiles(path: string, files: BundleFile[], replace = false) {
    if (existsSync(path) && !replace) return;
    const staging = `${path}.staging-${randomUUID()}`;
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    try {
      for (const file of files) {
        const destination = join(staging, file.path);
        mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
        writeFileSync(destination, file.bytes, { mode: file.executable ? 0o700 : 0o600 });
      }
      if (existsSync(path)) {
        const previous = `${path}.previous-${randomUUID()}`;
        renameSync(path, previous);
        try { renameSync(staging, path); } catch (error) { renameSync(previous, path); throw error; }
        rmSync(previous, { recursive: true, force: true });
      } else renameSync(staging, path);
    } finally { rmSync(staging, { recursive: true, force: true }); }
  }
  private migrate(builtinDirectory?: string) {
    if (this.store.state.skillCatalogVersion !== undefined && this.store.state.skillCatalogVersion !== 1) throw new DomainError("共享 Skill 数据版本较新，当前程序无法迁移");
    const catalog = [...this.catalog()];
    const assignments = new Map<string, string[]>();
    if (builtinDirectory && existsSync(join(builtinDirectory, "skills"))) {
      for (const name of readdirSync(join(builtinDirectory, "skills")).sort()) {
        const id = `builtin-${name}`;
        if (catalog.some(s => s.id === id)) continue;
        const bundle = this.readDirectory(join(builtinDirectory, "skills", name));
        const record: SharedSkill = { id, name: bundle.name, plugin: "raft", description: bundle.description, version: bundle.version, publishedAt: new Date().toISOString() };
        this.writeFiles(this.release(record), bundle.files);
        this.writeFiles(this.source(id), bundle.files);
        catalog.push(record);
      }
    }
    if (this.store.state.skillCatalogVersion !== 1) {
      for (const old of this.store.state.publishedSkills ?? []) {
        const bundle = this.readDirectory(resolve(this.directory, old.agentId, "releases", old.version));
        if (bundle.name !== old.name) throw new DomainError("旧 Skill 登记与发布文件名称不一致");
        const id = catalog.some(s => s.id === old.name) ? `${old.name}--${old.agentId}` : old.name;
        const record: SharedSkill = { id, name: old.name, plugin: "raft-local", ownerAgentId: old.agentId, description: bundle.description, version: bundle.version, publishedAt: old.publishedAt };
        this.writeFiles(this.release(record), bundle.files);
        this.writeFiles(this.source(id), bundle.files);
        catalog.push(record);
        assignments.set(old.agentId, [...(assignments.get(old.agentId) ?? []), id]);
      }
    }
    if (this.store.state.skillCatalogVersion !== 1 || catalog.length !== this.catalog().length) {
      this.store.transact(s => {
        s.skillCatalog = catalog; s.skillCatalogVersion = 1;
        for (const a of s.agents) if (a.skillIds === undefined) a.skillIds = [...catalog.filter(x => x.plugin === "raft").map(x => x.id), ...(assignments.get(a.id) ?? [])];
        delete s.publishedSkills;
      });
    }
  }
  private actor(actor: Actor): AgentActor {
    if (actor.kind !== "agent") throw new DomainError("Skill 命令需要 Agent 运行身份");
    if (!this.store.state.runs.some(r => r.id === actor.runId && r.agentId === actor.agentId && r.status === "running") || this.agent(actor.agentId).status !== "running") throw new DomainError("运行已结束或被停止，命令被拒绝");
    return actor;
  }
  /** Generated links only: the maintained files live in sources/ and releases/. */
  prepare(agentId: string, plugin: SharedSkill["plugin"] = "raft-local"): string {
    const path = resolve(this.directory, "views", agentId, plugin);
    const skillsDir = join(path, "skills");
    mkdirSync(join(path, ".claude-plugin"), { recursive: true, mode: 0o700 });
    mkdirSync(skillsDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(path, ".claude-plugin", "plugin.json"), JSON.stringify({ name: plugin, version: "1.0.0", description: "按 Agent 配置生成的共享 Skill 视图" }));
    const records = this.records(agentId, plugin);
    for (const entry of readdirSync(skillsDir)) {
      const target = join(skillsDir, entry);
      if (!lstatSync(target).isSymbolicLink()) throw new DomainError("托管 Skill 投影被修改，请先核验目录");
      if (!records.some(s => s.name === entry)) unlinkSync(target);
    }
    for (const skill of records) {
      const release = this.release(skill);
      if (!existsSync(join(release, "SKILL.md"))) throw new DomainError(`Skill ${skill.name} 的发布文件缺失`);
      const temp = join(skillsDir, `.link-${randomUUID()}`);
      try { symlinkSync(release, temp, "dir"); renameSync(temp, join(skillsDir, skill.name)); }
      finally { if (existsSync(temp)) unlinkSync(temp); }
    }
    return path;
  }
  private readBundle(actor: AgentActor, source: unknown) {
    const workspace = this.store.state.agents.find(a => a.id === actor.agentId)!.workspace;
    const rel = relative(resolve(workspace), resolve(workspace, required(source, "source")));
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) throw new DomainError("source 必须是当前工作目录内的 Skill 子目录");
    let root = realpathSync(workspace);
    for (const part of rel.split(sep)) {
      root = join(root, part);
      if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw new DomainError("Skill 来源不允许符号链接或非目录");
    }
    return this.readDirectory(root);
  }
  private readDirectory(root: string) {
    if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw new DomainError("Skill 来源不允许符号链接或非目录");
    const files: BundleFile[] = []; let total = 0;
    const walk = (folder: string, prefix = "", depth = 0) => {
      if (depth > 8) throw new DomainError("Skill 目录层级超过 8 层");
      for (const entry of readdirSync(folder).sort()) {
        if (entry.startsWith(".")) throw new DomainError("Skill 不允许隐藏文件或配置目录");
        if (!prefix && !["SKILL.md", "scripts", "references", "assets"].includes(entry)) throw new DomainError("Skill 仅接受 SKILL.md、scripts、references、assets");
        const path = join(folder, entry); const stat = lstatSync(path); const file = prefix ? `${prefix}/${entry}` : entry;
        if (stat.isSymbolicLink()) throw new DomainError("Skill 包内不允许符号链接");
        if (stat.isDirectory()) { walk(path, file, depth + 1); continue; }
        if (!stat.isFile()) throw new DomainError("Skill 包只能包含普通文件");
        total += stat.size;
        if (files.length >= 128 || total > 2_000_000) throw new DomainError("Skill 最多 128 个文件、总计 2 MB");
        const bytes = readFileSync(path);
        if (bytes.length !== stat.size) throw new DomainError("Skill 文件正在变化，请完成编写后重试");
        files.push({ path: file, bytes, executable: !!(stat.mode & 0o111) });
      }
    };
    walk(root);
    const text = files.find(f => f.path === "SKILL.md")?.bytes.toString("utf8");
    const match = text && /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]+)$/.exec(text);
    if (!match || !match[2]!.trim()) throw new DomainError("SKILL.md 需要 YAML frontmatter 和非空正文");
    const doc = parseDocument(match[1]!, { uniqueKeys: true });
    if (doc.errors.length) throw new DomainError("Skill frontmatter YAML 无效");
    const metadata: unknown = doc.toJS({ maxAliasCount: 0 });
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new DomainError("Skill frontmatter 必须是对象");
    const fields = metadata as Record<string, unknown>;
    if (Object.keys(fields).some(key => !["name", "description", "argument-hint"].includes(key))) throw new DomainError("仅支持 name、description、argument-hint；权限、hooks 和子代理由宿主管理");
    const name = required(fields.name, "Skill name");
    if (name.length > 64 || !validName.test(name)) throw new DomainError("Skill name 仅使用小写字母、数字和连字符，最长 64 字符");
    const description = required(fields.description, "Skill description");
    if (description.length > 1024) throw new DomainError("Skill description 最长 1024 字符");
    if (fields["argument-hint"] !== undefined) required(fields["argument-hint"], "argument-hint");
    if (/!`/.test(text!)) throw new DomainError("Skill 不支持内联 shell 展开；请通过 Bash 显式执行本地 CLI");
    const version = fingerprint(files.map(f => ({ path: f.path, data: f.bytes.toString("base64"), executable: f.executable })));
    return { name, description, version, files };
  }
  execute(actor: Actor, command: Command, query: () => SkillQuery | undefined): Promise<unknown> {
    if (actor.kind === "agent") this.actor(actor);
    const work = this.queue.catch(() => {}).then(() => this.command(actor, command, query));
    this.queue = work.catch(() => {});
    return work;
  }
  private async command(actor: Actor, command: Command, query: () => SkillQuery | undefined) {
    if (actor.kind === "agent") this.actor(actor);
    if (command.name === "skill.catalog") return { skills: this.catalogView() };
    if (command.name === "skill.list") return { skills: this.catalogView().filter(s => actor.kind === "user" || this.enabledIds(actor.agentId).includes(s.id)) };
    if (command.name === "skill.reload") {
      const who = this.actor(actor);
      return { status: "unchanged", refresh: await this.refresh(who, query) };
    }
    if (!["skill.publish", "skill.remove", "skill.configure"].includes(command.name)) throw new DomainError(`未知命令：${command.name}`);
    const key = `${actor.kind === "user" ? "user" : actor.agentId}:${required(command.requestId, "requestId")}`;
    const hash = fingerprint({ name: command.name, args: command.args });
    const prior = this.store.state.requests[key];
    let result: Record<string, unknown>;
    if (prior) {
      if (prior.fingerprint !== hash) throw new DomainError("同一 requestId 不可用于不同内容");
      result = prior.result as Record<string, unknown>;
    } else if (command.name === "skill.configure") {
      if (actor.kind !== "user") throw new DomainError("仅用户可配置 Agent 启用的共享 Skills");
      const agent = this.agent(required(command.args.agentId, "agentId"));
      const ids = command.args.ids;
      if (!Array.isArray(ids) || ids.length > 34 || ids.some(id => typeof id !== "string" || !this.catalog().some(s => s.id === id)) || new Set(ids).size !== ids.length) throw new DomainError("Skills 配置包含未知、重复项或超过 34 项");
      const selected = this.catalog().filter(s => ids.includes(s.id));
      if (new Set(selected.map(s => `${s.plugin}:${s.name}`)).size !== selected.length) throw new DomainError("不能同时启用同名 Skill 的多个来源");
      result = { status: "configured", agentId: agent.id, ids, effective: "next-run" };
      this.store.transact(s => {
        s.agents.find(a => a.id === agent.id)!.skillIds = [...ids];
        s.requests[key] = { fingerprint: hash, result };
        this.store.event(s, "skill.configured", `${agent.name} 的 Skills 配置已保存，下一轮生效`);
      });
    } else if (command.name === "skill.publish") {
      const existing = actor.kind === "user"
        ? this.catalog().find(s => s.id === required(command.args.id, "id"))
        : undefined;
      if (actor.kind === "user" && !existing) throw new DomainError("Skill 不存在");
      const bundle = actor.kind === "agent" ? this.readBundle(actor, command.args.source) : this.readDirectory(this.source(existing!.id));
      if (existing && bundle.name !== existing.name) throw new DomainError("不能修改已发布 Skill 的名称");
      const owned = existing ?? this.catalog().find(s => s.plugin === "raft-local" && s.name === bundle.name && s.ownerAgentId === (actor.kind === "agent" ? actor.agentId : undefined));
      if (!owned && this.catalog().some(s => s.plugin === "raft-local" && s.name === bundle.name)) throw new DomainError("同名共享 Skill 已存在；请由维护者更新，或使用新名称");
      const id = owned?.id ?? `local-${bundle.name}`;
      if (!owned && this.catalog().some(s => s.id === id)) throw new DomainError("Skill 标识冲突，请使用新名称");
      if (actor.kind === "agent" && !this.enabledIds(actor.agentId).includes(id) && this.enabledIds(actor.agentId).length >= 34) throw new DomainError("每个 Agent 最多启用 34 个 Skills");
      const skill: SharedSkill = { id, name: bundle.name, plugin: owned?.plugin ?? "raft-local", description: bundle.description, version: bundle.version, publishedAt: new Date().toISOString(), ...(owned?.ownerAgentId ? { ownerAgentId: owned.ownerAgentId } : actor.kind === "agent" ? { ownerAgentId: actor.agentId } : {}) };
      if (actor.kind === "agent" && this.records(actor.agentId).some(s => s.id !== id && s.plugin === skill.plugin && s.name === skill.name)) throw new DomainError("已启用同名 Skill 的其他来源，请先调整配置");
      this.writeFiles(this.release(skill), bundle.files);
      this.writeFiles(this.source(id), bundle.files, actor.kind === "agent");
      result = { status: "published", id, name: skill.name, skill: `${skill.plugin}:${skill.name}`, version: skill.version, directory: this.release(skill), source: this.source(id) };
      this.store.transact(s => {
        s.skillCatalog = [...(s.skillCatalog ?? []).filter(x => x.id !== id), skill];
        if (actor.kind === "agent") {
          const a = s.agents.find(x => x.id === actor.agentId)!;
          a.skillIds = [...new Set([...this.enabledIds(actor.agentId), id])];
        }
        s.requests[key] = { fingerprint: hash, result };
        this.store.event(s, "skill.published", `${skill.name} 已发布到共享目录`);
      });
    } else {
      const who = this.actor(actor);
      const name = required(command.args.name, "Skill name");
      if (!validName.test(name)) throw new DomainError("使用 skill.list 中的本地 name，不含插件前缀");
      const found = this.records(who.agentId, "raft-local").find(s => s.name === name);
      result = { status: "removed", name, skill: `raft-local:${name}` };
      this.store.transact(s => {
        s.agents.find(a => a.id === who.agentId)!.skillIds = this.enabledIds(who.agentId).filter(id => id !== found?.id);
        s.requests[key] = { fingerprint: hash, result };
        this.store.event(s, "skill.removed", `${name} 已从当前 Agent 停用，共享文件保留`);
      });
    }
    const refresh = actor.kind === "agent" ? await this.refresh(actor, query) : { status: "next-run" };
    return { ...result, ...(command.name === "skill.publish" ? { active: this.catalog().some(s => s.id === result.id && s.version === result.version) && (actor.kind === "user" || this.enabledIds(actor.agentId).includes(String(result.id))) } : {}), refresh };
  }
  private async refresh(actor: AgentActor, query: () => SkillQuery | undefined) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      this.actor(actor);
      this.prepare(actor.agentId); this.prepare(actor.agentId, "raft");
      const current = query();
      if (!current) throw new Error("当前 SDK Query 尚未就绪");
      const response = await Promise.race([
        current.reloadSkills(),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("SDK 刷新超时，可执行 skill.reload 重试")), 8000); }),
      ]);
      this.actor(actor);
      if (query() !== current) throw new Error("SDK Query 已切换，请在当前运行重新刷新");
      const loaded = response.skills.filter(s => s.name.startsWith("raft-local:")).map(s => s.name).sort();
      const expected = this.records(actor.agentId, "raft-local").map(s => `${s.plugin}:${s.name}`).sort();
      if (JSON.stringify(loaded) !== JSON.stringify(expected)) throw new Error("SDK 发现列表与配置不一致，请执行 skill.reload 重试");
      return { status: "loaded", skills: loaded };
    } catch (error) {
      return { status: "pending", error: error instanceof Error ? error.message : String(error), retry: "raftctl skill reload --json" };
    } finally { clearTimeout(timeout); }
  }
  async close() { await this.queue; }
}
