// 使用桌面有效模型配置做一次原生 WebSearch 验证；不改应用工具白名单。
import { config } from "dotenv";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { createAgentOptions } from "../src/config.js";
import { ModelSettings } from "../src/model-settings.js";
import { runSession } from "../src/agent.js";
import type { Query } from "@anthropic-ai/claude-agent-sdk";

config({ path: resolve(".env"), quiet: true });
const settings = new ModelSettings(process.env.RAFT_DATA_DIR || join(homedir(), "Library/Application Support/RaftAgent"), process.env);
const controller = new AbortController();
const dir = await mkdtemp(join(tmpdir(), "raft-search-sdk-"));
const secrets = [settings.env.ANTHROPIC_API_KEY, settings.env.ANTHROPIC_AUTH_TOKEN].filter((s): s is string => !!s);
const redact = (text: string) => secrets.reduce((value, secret) => value.split(secret).join("[REDACTED]"), text);
const report = {
  at: new Date().toISOString(), sdk: "0.3.267", config: settings.view(),
  session: "", availableTools: [] as string[], calls: [] as { id: string; name: string; input: unknown }[],
  outputs: [] as { id: string; error: boolean; content: string }[],
  final: "", error: "", timedOut: false, sdkCostUsd: null as number | null, elapsedMs: 0, passed: false,
};
let stream: Query | undefined;
const started = Date.now();
const timeout = setTimeout(() => { report.timedOut = true; controller.abort(); stream?.close(); }, 90_000);
const progress = setInterval(() => console.log(JSON.stringify({ elapsedSeconds: Math.round((Date.now() - started) / 1000), initialized: !!report.session, tools: report.calls.map(c => c.name), outputs: report.outputs.length })), 20_000);
try {
  const base = createAgentOptions(settings.env, dir, controller);
  console.log(JSON.stringify({ testing: "WebSearch", configuration: settings.view(), timeoutSeconds: 90, maxTurns: 3, sdkBudgetUsd: 0.3 }));
  await runSession(
    'Call WebSearch exactly once with query "Claude Agent SDK official documentation TypeScript". Then report two source URLs actually returned by the tool. Do not answer from memory or invoke any other tool. If WebSearch fails, report the exact failure and stop. Keep the final answer short.',
    { ...base, tools: ["WebSearch"], allowedTools: ["WebSearch"], settings: { disableBundledSkills: true },
      systemPrompt: "You are testing the SDK native WebSearch tool. Use it once. Report observed results only.",
      maxTurns: 3, maxBudgetUsd: 0.3, maxThinkingTokens: 1024,
      canUseTool: async (name, input) => name === "WebSearch" ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "Only WebSearch is authorized for this test." },
    },
    message => {
      if (message.type === "system" && message.subtype === "init") { report.session = message.session_id; report.availableTools = message.tools; }
      if (message.type === "assistant") for (const block of message.message.content) {
        if (block.type === "tool_use") { report.calls.push({ id: block.id, name: block.name, input: block.input }); console.log(JSON.stringify({ tool: block.name })); }
      }
      if (message.type === "user" && Array.isArray(message.message.content)) for (const block of message.message.content) {
        if (block.type === "tool_result") report.outputs.push({ id: block.tool_use_id, error: !!block.is_error, content: redact(JSON.stringify(block.content) ?? "").slice(0, 24_000) });
      }
      if (message.type === "result") { report.sdkCostUsd = message.total_cost_usd; if (message.subtype === "success") report.final = redact(message.result); }
    }, value => { stream = value; },
  );
} catch (error) { report.error = redact(error instanceof Error ? error.message : String(error)); }
finally {
  clearTimeout(timeout); clearInterval(progress); stream?.close();
  report.elapsedMs = Date.now() - started;
  const calls = report.calls.filter(c => c.name === "WebSearch");
  report.passed = !report.error && !report.timedOut && calls.length === 1 && report.outputs.some(output => calls.some(c => c.id === output.id) && !output.error && /https?:\/\//.test(output.content));
  const output = resolve(".raft/verification/search-sdk-live.json");
  await mkdir(resolve(".raft/verification"), { recursive: true });
  await writeFile(output, redact(JSON.stringify(report, null, 2)) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ passed: report.passed, timedOut: report.timedOut, error: report.error, calls: report.calls.length, outputs: report.outputs, final: report.final, sdkCostUsd: report.sdkCostUsd, report: output }, null, 2));
  await rm(dir, { recursive: true, force: true });
}
if (!report.passed) process.exitCode = 1;
