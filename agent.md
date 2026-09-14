# 项目开发约定

## Claude Agent SDK 优先

本项目以 **Claude Agent SDK** 为 Agent 实现基础，使用 TypeScript 包 `@anthropic-ai/claude-agent-sdk`，运行于 Node.js 24+，采用 ESM。需求中所说的“Claude ADK”在本项目中统一指 Claude Agent SDK。

项目以 TypeScript 为唯一应用实现语言，不维护历史语言入口、依赖或兼容层。后续桌面端和多 Agent 功能继续基于这一技术栈设计。

- 后续功能实现必须优先使用 SDK 已提供的 API、内置工具、配置选项和扩展机制，尽可能复用官方能力，避免重复造轮子。
- SDK 已负责的 Agent 循环、工具执行、上下文管理和重试，不得在未确认能力缺口前重新实现一套。
- 自定义代码应聚焦于业务逻辑和必要的集成；扩展 SDK 时优先考虑官方自定义工具、MCP、Hooks 等机制，具体接口以文档和项目安装版本为准。

## 实现前必须先查文档

每次新增功能或修改功能实现前，必须先完成以下步骤，不能仅凭记忆或已有示例直接编码：

1. 明确需求，查阅官方文档中对应的功能章节和 TypeScript API 参考，确认 SDK 是否已有直接支持的方法或可组合使用的能力。
2. 核对项目实际安装的 SDK 版本、方法签名、配置项和适用限制，不能直接照搬其他语言接口或其他版本的示例。依赖版本通过 `package-lock.json` 锁定。
3. 在实现说明中简要记录：查阅的文档链接、准备复用的 SDK 能力，以及选择理由。小改动可写在任务说明中；涉及架构取舍时写入项目文档。
4. 优先通过 SDK 原生能力完成需求；需要扩展时，使用官方扩展点并保持封装最小化。
5. 只有确认 SDK 没有合适能力，或现有能力无法满足明确的业务约束时，才补充自定义实现，并记录能力缺口、未采用 SDK 方案的原因和自定义实现的边界。

如果无法访问官方文档，应明确说明，并查阅与安装版本匹配的本地 SDK 文档、类型定义或源码进行核验；不得把未经核实的猜测当成“SDK 不支持”的依据。

## 优先核查的能力

| 需求 | 实现前优先查阅 |
| --- | --- |
| 单次任务、Agent 循环和消息输出 | `query`、`Options`、`SDKMessage` 与流式输出 |
| 持续对话、会话恢复 | `query` 的流式输入、`resume`、`continue` 与官方会话管理能力 |
| 文件读取、搜索、编辑、命令执行 | 内置工具及对应权限配置 |
| 业务工具、外部服务接入 | 自定义工具、SDK MCP server 与外部 MCP server 接入 |
| 工具调用前后处理、执行控制 | Hooks、权限配置与官方回调机制 |
| 多 Agent、结构化结果等扩展功能 | 官方子代理、结构化输出章节及 TypeScript 版本支持情况 |

以上是查阅方向，不代表相关能力能自动满足业务所需的持久化、并发控制或可靠性保证；这些边界也必须根据文档核实。

## 官方文档入口

- [快速开始](https://code.claude.com/docs/zh-CN/agent-sdk/quickstart)
- [Agent SDK 概览](https://code.claude.com/docs/zh-CN/agent-sdk/overview)
- [TypeScript SDK 参考](https://code.claude.com/docs/zh-CN/agent-sdk/typescript)

快速开始用于建立基本用法；实现具体功能时必须继续查阅对应专题和 API 参考。

## 开发与验证

- `npm ci` 安装锁定依赖，`npm run dev -- "任务"` 运行开发入口。
- 完成代码变更后运行 `npm run check`，检查类型、自动化测试和构建。
- CLI 输入输出放在 `src/cli.ts`；SDK 执行放在 `src/agent.ts`；配置校验放在 `src/config.ts`。
- 不提交 `.env`、`node_modules` 或 `dist`。
