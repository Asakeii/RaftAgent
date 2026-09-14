// 使用真实 SDK 控制通道，不投递模型输入、不需要 API key。
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { startService } from "../src/server.js";
import { sendControl, controlCommand } from "../src/control.js";
import type { Agent } from "../src/contracts.js";

const dir = await mkdtemp(join(tmpdir(), "raft-skills-sdk-"));
const service = await startService(resolve("."), dir, {});
const agent = service.store.execute({ kind: "user" }, { name: "agent.create", args: { name: "Probe", role: "test" }, requestId: "create" }) as Agent;
const plugin = service.skills.prepare(agent.id);
let release!: () => void;
const wait = new Promise<void>(r => { release = r; });
async function* input(): AsyncGenerator<SDKUserMessage> { await wait; }
const stream = query({ prompt: input(), options: {
  cwd: agent.workspace, env: { ...process.env, ANTHROPIC_API_KEY: "test" }, settingSources: [], strictMcpConfig: true, mcpServers: {},
  plugins: [{ type: "local", path: plugin, skipMcpDiscovery: true }], skills: "all", tools: ["Read", "Skill"], settings: { disableBundledSkills: true }, persistSession: false,
} });
const timer = setTimeout(() => { release(); stream.close(); }, 30_000);
try {
  const init = await stream.initializationResult();
  assert.ok(!init.commands.some(c => c.name === "raft-local:echo-local"));
  service.store.transact(s => { s.agents[0]!.status = "running"; s.runs.push({ id: "run", agentId: agent.id, inputId: "none", status: "running", at: "now" }); });
  service.scheduler.tokens.set("probe", { kind: "agent", agentId: agent.id, runId: "run", channel: agent.id });
  service.scheduler.active.set(agent.id, { controller: new AbortController(), query: stream, done: Promise.resolve() });
  const source = join(agent.workspace, "draft"); await mkdir(source);
  const doc = (text: string) => `---\nname: echo-local\ndescription: Test hot loading.\n---\n${text}\n`;
  await writeFile(join(source, "SKILL.md"), doc("Version one"));
  const call = async (args: string[]) => {
    const response = await sendControl(await controlCommand(args, async () => ""), { RAFT_SOCKET: service.socket, RAFT_RUN_TOKEN: "probe" });
    assert.equal(response.ok, true); return response.data as any;
  };
  const first = await call(["skill", "publish", "--source", "draft", "--request-id", "first"]);
  assert.equal(first.refresh.status, "loaded", JSON.stringify(first));
  assert.ok(first.refresh.skills.includes("raft-local:echo-local"));
  assert.ok((await stream.supportedCommands()).some(c => c.name === "raft-local:echo-local"));
  await writeFile(join(source, "SKILL.md"), doc("Version two"));
  const updated = await call(["skill", "publish", "--source", "draft", "--request-id", "second"]);
  assert.equal(updated.refresh.status, "loaded"); assert.notEqual(updated.version, first.version);
  const removed = await call(["skill", "remove", "--name", "echo-local", "--request-id", "remove"]);
  assert.equal(removed.refresh.status, "loaded"); assert.deepEqual(removed.refresh.skills, []);
  assert.ok(!(await stream.supportedCommands()).some(c => c.name === "raft-local:echo-local"));
  assert.equal((await stream.mcpServerStatus()).length, 0);
  console.log("SKILLS_SDK_OK: 同一个真实 Query 经 CLI/socket 发布、更新、移除并刷新；无模型输入、无 MCP");
} finally {
  clearTimeout(timer); release(); stream.close(); service.scheduler.active.delete(agent.id);
  await service.close(); await rm(dir, { recursive: true, force: true });
}
