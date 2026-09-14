import assert from "node:assert/strict";
import test from "node:test";
import { createAgentOptions } from "../src/config.js";

const options = (env: NodeJS.ProcessEnv) => createAgentOptions(env, "/project", new AbortController());

test("缺少或空白 API Key 时立即失败", () => {
  for (const key of [undefined, "", "   "]) {
    assert.throws(() => options({ ANTHROPIC_API_KEY: key }), /ANTHROPIC_API_KEY/);
  }
});

test("默认端点和环境继承正确，工具及外部设置保持受控", () => {
  const env = { ANTHROPIC_API_KEY: "test-key", PATH: "/custom/bin" };
  const controller = new AbortController();
  const result = createAgentOptions(env, "/project", controller);
  assert.equal(result.env?.PATH, "/custom/bin");
  assert.equal(result.env?.ANTHROPIC_BASE_URL, "https://api.anthropic.com");
  assert.equal(result.cwd, "/project");
  assert.equal(result.abortController, controller);
  assert.deepEqual(result.tools, ["Read", "Glob", "Grep"]);
  assert.deepEqual(result.settingSources, []);
  assert.equal(result.strictMcpConfig, true);
  assert.deepEqual(result.mcpServers, {});
  assert.equal(result.maxTurns, 10);
  assert.equal("ANTHROPIC_BASE_URL" in env, false);
});

test("完整接口路径和无效地址在启动 SDK 前被拒绝", () => {
  for (const url of [
    "https://example.com/v1/messages/", "https://example.com/v1/chat/completions",
    "file:///tmp/api", "not-a-url", "https://example.com/?key=secret",
  ]) {
    assert.throws(() => options({ ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: url }));
  }
});

test("火山方舟要求显式模型，并规范化基础地址", () => {
  const env = {
    ANTHROPIC_API_KEY: "test-key",
    ANTHROPIC_BASE_URL: "https://ark.cn-beijing.volces.com/api/compatible/",
  };
  assert.throws(() => options(env), /ANTHROPIC_MODEL/);
  const result = options({ ...env, ANTHROPIC_MODEL: "test-model" });
  assert.equal(result.model, "test-model");
  assert.equal(result.env?.ANTHROPIC_BASE_URL, "https://ark.cn-beijing.volces.com/api/compatible");
});
