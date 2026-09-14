import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, symlinkSync, unlinkSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parseDocument } from "yaml";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import type { Actor, Command, PublishedSkill } from "./contracts.js";
import { DomainError, required, Store } from "./store.js";

type AgentActor = Extract<Actor, { kind: "agent" }>;
type SkillQuery = Pick<Query, "reloadSkills">;
type BundleFile = { path: string; bytes: Buffer; executable: boolean };
const validName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const pluginName = "raft-local";
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** 应用只管理文件发布和归属；发现、加载和工具执行仍由 SDK 完成。 */
export class SkillManager {
  private queues = new Map<string, Promise<unknown>>();
  constructor(readonly store: Store, readonly directory: string) {}
  private records(agentId: string) { return (this.store.state.publishedSkills ?? []).filter(s => s.agentId === agentId); }
  private release(skill: PublishedSkill) { return resolve(this.directory, skill.agentId, "releases", skill.version); }
  private actor(actor: Actor): AgentActor {
    if (actor.kind !== "agent") throw new DomainError("Skill 命令需要 Agent 运行身份");
    if (!this.store.state.runs.some(r => r.id === actor.runId && r.agentId === actor.agentId && r.status === "running") || this.store.state.agents.find(a => a.id === actor.agentId)?.status !== "running") throw new DomainError("运行已结束或被停止，命令被拒绝");
    return actor;
  }
  /** 每轮启动和热刷新前按持久记录重建投影，修复发布后异常退出留下的目录差异。 */
  prepare(agentId: string): string {
    const path = resolve(this.directory, agentId, "plugin");
    const skillsDir = join(path, "skills");
    mkdirSync(join(path, ".claude-plugin"), { recursive: true, mode: 0o700 });
    mkdirSync(skillsDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(path, ".claude-plugin", "plugin.json"), JSON.stringify({ name: pluginName, version: "1.0.0", description: "当前 Agent 发布的本地 Skills，不含 MCP" }));
    const records = this.records(agentId);
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
    const who = this.actor(actor);
    const previous = this.queues.get(who.agentId) ?? Promise.resolve();
    const work = previous.catch(() => {}).then(() => this.command(who, command, query));
    this.queues.set(who.agentId, work);
    void work.finally(() => { if (this.queues.get(who.agentId) === work) this.queues.delete(who.agentId); }).catch(() => {});
    return work;
  }
  private async command(actor: AgentActor, command: Command, query: () => SkillQuery | undefined) {
    this.actor(actor);
    if (command.name === "skill.list") return { skills: this.records(actor.agentId).map(s => ({ ...s, skill: `${pluginName}:${s.name}`, directory: this.release(s) })) };
    if (!["skill.publish", "skill.remove", "skill.reload"].includes(command.name)) throw new DomainError(`未知命令：${command.name}`);
    let result: Record<string, unknown> = { status: "unchanged" };
    if (command.name !== "skill.reload") {
      const key = `${actor.agentId}:${required(command.requestId, "requestId")}`;
      const hash = fingerprint({ name: command.name, args: command.args });
      const prior = this.store.state.requests[key];
      if (prior) {
        if (prior.fingerprint !== hash) throw new DomainError("同一 requestId 不可用于不同内容");
        result = prior.result as Record<string, unknown>;
      } else if (command.name === "skill.publish") {
        const bundle = this.readBundle(actor, command.args.source);
        const records = this.records(actor.agentId);
        if (!records.some(s => s.name === bundle.name) && records.length >= 32) throw new DomainError("每个 Agent 最多发布 32 个 Skills");
        const skill: PublishedSkill = { agentId: actor.agentId, name: bundle.name, description: bundle.description, version: bundle.version, publishedAt: new Date().toISOString() };
        const path = this.release(skill);
        if (!existsSync(path)) {
          const staging = `${path}.staging-${randomUUID()}`;
          mkdirSync(staging, { recursive: true, mode: 0o700 });
          for (const file of bundle.files) {
            const destination = join(staging, file.path);
            mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
            writeFileSync(destination, file.bytes, { mode: file.executable ? 0o700 : 0o600 });
          }
          renameSync(staging, path);
        }
        result = { status: "published", name: skill.name, skill: `${pluginName}:${skill.name}`, version: skill.version, directory: path };
        this.store.transact(s => {
          s.publishedSkills = [...(s.publishedSkills ?? []).filter(x => x.agentId !== actor.agentId || x.name !== skill.name), skill];
          s.requests[key] = { fingerprint: hash, result };
          this.store.event(s, "skill.published", `${skill.name} 已发布，等待当前会话刷新`);
        });
      } else {
        const name = required(command.args.name, "Skill name");
        if (!validName.test(name)) throw new DomainError("使用 skill.list 中的本地 name，不含插件前缀");
        result = { status: "removed", name, skill: `${pluginName}:${name}` };
        this.store.transact(s => {
          s.publishedSkills = (s.publishedSkills ?? []).filter(x => x.agentId !== actor.agentId || x.name !== name);
          s.requests[key] = { fingerprint: hash, result };
          this.store.event(s, "skill.removed", `${name} 已移除，等待当前会话刷新`);
        });
      }
    }
    // 发布已提交，即使刷新超时也不回滚磁盘；原 request-id 可查询/重试。
    const refresh = await this.refresh(actor, query);
    return { ...result, ...(command.name === "skill.publish" ? { active: this.records(actor.agentId).some(s => s.name === result.name && s.version === result.version) } : {}), refresh };
  }
  private async refresh(actor: AgentActor, query: () => SkillQuery | undefined) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      this.actor(actor);
      this.prepare(actor.agentId);
      const current = query();
      if (!current) throw new Error("当前 SDK Query 尚未就绪");
      const response = await Promise.race([
        current.reloadSkills(),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("SDK 刷新超时，可执行 skill.reload 重试")), 8000); }),
      ]);
      this.actor(actor);
      if (query() !== current) throw new Error("SDK Query 已切换，请在当前运行重新刷新");
      const loaded = response.skills.filter(s => s.name.startsWith(`${pluginName}:`)).map(s => s.name).sort();
      const expected = this.records(actor.agentId).map(s => `${pluginName}:${s.name}`).sort();
      if (JSON.stringify(loaded) !== JSON.stringify(expected)) throw new Error("SDK 发现列表与发布列表不一致，请执行 skill.reload 重试");
      return { status: "loaded", skills: loaded };
    } catch (error) {
      return { status: "pending", error: error instanceof Error ? error.message : String(error), retry: "raftctl skill reload --json" };
    } finally { clearTimeout(timeout); }
  }
  async close() { await Promise.allSettled(this.queues.values()); }
}
