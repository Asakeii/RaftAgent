import { query, type Options, type Query, type SDKUserMessage, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

type QueryStream = Pick<Query, typeof Symbol.asyncIterator | "close">;
type QueryFactory = (input: { prompt: string; options: Options }) => QueryStream;

export interface AgentOutput {
  log: (message: string) => void;
  error: (message: string) => void;
}

// 桌面运行时只向 SDK 投递一个输入；保留流式通道直到对应 result，以支持 interrupt。
export async function runSession(prompt: string, options: Options, onMessage: (message: SDKMessage) => void, onQuery: (stream: Query) => void, inputId?: string): Promise<void> {
  let endInput!: () => void;
  const ended = new Promise<void>(resolve => { endInput = resolve; });
  async function* input(): AsyncGenerator<SDKUserMessage> {
    yield { type: "user", message: { role: "user", content: prompt }, parent_tool_use_id: null, ...(inputId ? { uuid: inputId as NonNullable<SDKUserMessage["uuid"]> } : {}) };
    await ended;
  }
  const stream = query({ prompt: input(), options });
  onQuery(stream);
  let resultSeen = false;
  try {
    for await (const message of stream) {
      onMessage(message);
      if (message.type === "result") {
        resultSeen = true;
        if (message.subtype !== "success" || message.is_error) throw new Error(message.subtype === "success" ? message.result : `${message.subtype}: ${message.errors.join("; ")}`);
        break;
      }
    }
    if (!resultSeen) throw new Error("SDK 未返回完整结果");
  } finally {
    endInput();
    stream.close();
  }
}

// SDK 负责执行循环；此层只消费消息并向调用方返回退出状态。
export async function runAgent(
  prompt: string,
  options: Options,
  output: AgentOutput = console,
  startQuery: QueryFactory = query,
): Promise<number> {
  const stream = startQuery({ prompt, options });
  try {
    for await (const message of stream) {
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "tool_use") output.log(`[工具] ${block.name}`);
        }
      } else if (message.type === "result") {
        if (message.subtype === "success") {
          if (message.result) output.log(message.result);
          if (!message.is_error) return 0;
          output.error("[未完成] 模型返回错误");
        } else {
          output.error(`[未完成] ${message.subtype}`);
          for (const error of message.errors) output.error(error);
        }
        return 1;
      }
    }
    output.error("[未完成] SDK 消息流结束，但未返回最终结果。");
    return 1;
  } finally {
    stream.close();
  }
}
