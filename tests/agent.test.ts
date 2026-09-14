import assert from "node:assert/strict";
import test from "node:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { runAgent } from "../src/agent.js";

// 仅保留应用消费的消息字段；计费、会话等 SDK 元数据不影响这些测试。
const success = {
  type: "result", subtype: "success", is_error: false, result: "已完成",
} as SDKMessage;

function harness(messages: SDKMessage[], failure?: Error) {
  const logs: string[] = [];
  const errors: string[] = [];
  let closed = false;
  return {
    logs, errors,
    get closed() { return closed; },
    output: { log: (line: string) => { logs.push(line); }, error: (line: string) => { errors.push(line); } },
    start: () => ({
      async *[Symbol.asyncIterator]() {
        yield* messages;
        if (failure) throw failure;
      },
      close() { closed = true; },
    }),
  };
}

test("工具进度和最终结果各输出一次，并关闭 SDK 查询", async () => {
  const h = harness([
    { type: "assistant", message: { content: [
      { type: "text", text: "中间输出" },
      { type: "tool_use", name: "Read", id: "tool-1", input: {} },
    ] } } as SDKMessage,
    success,
  ]);
  assert.equal(await runAgent("任务", {}, h.output, h.start), 0);
  assert.deepEqual(h.logs, ["[工具] Read", "已完成"]);
  assert.deepEqual(h.errors, []);
  assert.equal(h.closed, true);
});

test("success 子类型带 is_error 时也必须返回失败", async () => {
  const h = harness([{ ...success, is_error: true } as SDKMessage]);
  assert.equal(await runAgent("任务", {}, h.output, h.start), 1);
  assert.match(h.errors.join("\n"), /模型返回错误/);
  assert.equal(h.closed, true);
});

test("达到轮次上限时报告具体原因，不误判为成功", async () => {
  const h = harness([{
    type: "result", subtype: "error_max_turns", is_error: true, errors: ["轮次耗尽"],
  } as SDKMessage]);
  assert.equal(await runAgent("任务", {}, h.output, h.start), 1);
  assert.deepEqual(h.errors, ["[未完成] error_max_turns", "轮次耗尽"]);
  assert.equal(h.closed, true);
});

test("没有最终结果的消息流返回失败", async () => {
  const h = harness([]);
  assert.equal(await runAgent("任务", {}, h.output, h.start), 1);
  assert.match(h.errors.join("\n"), /未返回最终结果/);
  assert.equal(h.closed, true);
});

test("SDK 异常或取消时仍关闭查询，并将异常交给 CLI", async () => {
  const h = harness([], new Error("aborted"));
  await assert.rejects(runAgent("任务", {}, h.output, h.start), /aborted/);
  assert.equal(h.closed, true);
});
