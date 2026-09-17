# RaftAgent

一个基于 Claude Agent SDK 的本地多 Agent 桌面助手。你可以为不同职责创建 Agent，单独交谈，也可以把它们放进同一个群聊，一起处理代码、资料和任务。

项目使用 TypeScript、React、Electron 和 SQLite，目前主要面向 macOS 本地开发运行，尚未提供签名安装包。

## 功能

- **私聊与群聊**：每个 Agent 的私聊和各群聊分别维护模型会话，支持历史记录、Markdown 和消息检索。
- **多 Agent 协作**：共享群消息、成员提及、子任务委派，以及任务领取、提交和用户验收。
- **明确的发言动作**：Agent 通过工具发送群消息，执行过程和结束说明不会自动混入聊天。发送时检查群版本，过时回复保留为待处理草稿。
- **运行控制**：发消息自动唤醒成员；运行时输入框的发送按钮变为停止按钮。私聊支持流式输出，群聊合并展示成员运行状态。
- **可扩展能力**：按成员启用 Skills，支持 Agent 编写、发布和热加载 Skill；可选 Tavily 联网搜索。
- **执行详情**：查看模型会话、工具调用、授权请求、运行日志和用量估算。

## 快速开始

### 环境要求

- Node.js **24 或更高版本**及 npm。
- macOS：当前主要开发和验证平台。
- Anthropic API Key，或支持 **Anthropic Messages 协议**的服务商凭据。

SDK 安装时会通过可选依赖提供所需的 Claude Code 二进制文件，请勿省略可选依赖；常规安装无需另外安装 Claude Code。

### 安装并启动

```bash
git clone https://github.com/Asakeii/RaftAgent.git
cd RaftAgent
npm ci
npm run desktop
```

`npm run desktop` 会构建应用并打开 Electron 窗口。使用 nvm 的开发者也可以先执行 `nvm use`。

首次打开后：

1. 打开左下角设置，填写 API Key、模型名称和 API 地址并保存。
2. 创建 Agent，填写名称与职责；应用会为它创建工作目录。
3. 在私聊中发送任务，或创建群聊、加入成员后发送消息。
4. 需要停止时，点击输入框中的方形停止按钮；发送新消息可以再次唤醒成员。

未配置 API Key 时仍可管理成员、群聊和查看历史，但不会调用模型。保存模型设置不会测试连通性，新配置从下一次运行生效。

也可以使用浏览器界面：

```bash
npm run web
```

在自己的浏览器打开终端输出的 URL。该地址包含本地访问凭据，不应分享给他人。桌面端和网页端不要同时使用同一数据目录启动服务。

## 模型配置

桌面和网页端推荐使用应用内设置。API 地址应填写兼容服务的**基础地址**，不要填写 `/messages` 或 `/chat/completions` 完整请求地址。

| 配置 | 说明 |
| --- | --- |
| API Key | 服务商提供的密钥 |
| API 地址 | Anthropic 官方服务为 `https://api.anthropic.com`，其他服务按其文档填写 |
| 模型 | 模型名称或服务商要求的推理接入点 ID |

应用设置优先于环境变量和 `.env`。Key 保存在数据目录的 `llm-settings.json`，文件权限为 `0600`，目前是本地明文存储，未接入系统钥匙串。设置中留空 Key 会保留已有值；清除需使用“清除 Key”。

尚未保存应用设置时，也可以通过项目根目录的 `.env` 配置：

```bash
cp .env.example .env
```

使用 Anthropic 官方服务的示例：

```dotenv
ANTHROPIC_API_KEY=your-api-key
ANTHROPIC_BASE_URL=https://api.anthropic.com
# 可选：指定账号可用的模型
# ANTHROPIC_MODEL=your-model-id
```

`.env.example` 另提供火山方舟兼容地址示例，使用时需填写已开通的模型或接入点 ID。模型及协议支持情况以服务商为准。已有环境变量优先于 `.env`，模型调用会产生 API 用量。

## 使用说明

### 群聊协作

在群聊中输入 `@` 可以选择成员，但普通消息也会唤醒群成员评估是否需要参与。用户的问候、提问和不完整需求都可以被回应；已有成员充分回答后，其他成员应避免重复接话。

群聊只有一份共享消息历史。Agent 通过 `raftctl room send` 显式发言，普通模型输出保存在执行详情中。多名成员同时回复时，服务会检查它们依据的群版本：版本过期的回复成为草稿，Agent 可以修改、重试或丢弃。群消息成功提交后整体显示，私聊则保留流式展示。

右侧状态栏可以查看成员、添加成员、管理任务和处理草稿。任务提交后由用户核验产物并验收；“Agent 已结束运行”不等于“任务已完成”。

私聊与各群聊使用独立 SDK 会话，但这不代表信息完全隔离：群运行会获得该 Agent 的近期私聊背景，也可以按权限检索其他场景。同一个 Agent 的不同会话仍共享其工作目录。详情见[群聊上下文设计](docs/progressive-room-context-design.md)和[共享 inbox 与发言规则](docs/shared-group-inbox.md)。

### 删除 Agent 和群聊

打开对应会话，点击顶部的“删除 Agent”或“删除群聊”，确认后删除。正在运行的对象需先停止并等待执行结束。删除 Agent 会移除私聊和群成员关系，群内已有发言保留，未完成的负责任务恢复为待领取；删除群聊会移除该群消息、任务和草稿，成员本身保留。工作目录、共享 Skills、SDK 原始文件与独立执行日志不随之清除。

### Skills 与联网搜索

在 Agent 会话顶部的 **Skills** 面板选择该成员可用的能力。Agent 可以在工作目录中编写 Skill，通过本地 CLI 发布，并在发布成功后热加载。共享 Skill 的源码、发布版本及成员启用配置由应用统一管理，详见[共享 Skill 说明](docs/shared-skills.md)。

联网搜索使用内置的 `raft:tavily-search` Skill，需要单独配置 Tavily Key。启动应用前可设置 `TAVILY_API_KEY`；也支持数据目录中的 `tavily-settings.json`。当前模型设置面板不管理该 Key。搜索和网页提取可能消耗 Tavily credits，配置方式见 [Tavily Skill](resources/raft-plugin/skills/tavily-search/SKILL.md)。

### 工具权限

文件修改和命令执行遵循 SDK 权限规则。设置中的 **YOLO** 模式会自动批准普通工具操作，请仅在信任任务和工作环境时开启。

Bash 使用 SDK 原生沙箱，禁止无沙箱回退；YOLO 不会关闭该沙箱。工作目录不是文件系统隔离边界，Read/Edit/Write 仍使用 SDK 权限系统。停止运行不会自动撤销已经执行的文件修改或外部操作。

### 单次命令行任务

无需桌面界面，也可以在项目目录运行一个只读任务：

```bash
npm run dev -- "读取 src/agent.ts，解释执行流程"
npm run dev -- --help
```

单次 CLI 使用环境变量和 `.env`，不读取桌面模型设置，默认开放 Read、Glob、Grep。按 `Ctrl+C` 取消执行。

`raftctl` 则是桌面服务为活动 Agent 提供的协作入口，运行身份由宿主注入；它与上述单次任务 CLI 用途不同。完整命令见[协作 Skill](resources/raft-plugin/skills/raft-collaboration/SKILL.md)。

## 数据与常见问题

macOS 默认数据目录：

```text
~/Library/Application Support/RaftAgent/
```

可通过启动环境变量 `RAFT_DATA_DIR` 指定其他位置。聊天及应用状态保存在 `raft.sqlite`，执行日志在 `traces.sqlite`，Agent 工作目录在 `workspaces/`，共享 Skills 在 `skills/`。SDK 模型会话文件由 SDK 单独管理，备份 SQLite 并不等于备份完整模型会话。

**提示“数据目录已被占用或上次未正常关闭”怎么办？**

这是 `service.lock` 阻止同一数据目录被多个服务写入。先退出旧应用，并根据锁文件中的 PID 核实旧服务及相关工具进程是否仍在运行。只有确认它们已停止后，才移除提示路径中的 `service.lock` 并重新启动；不要删除数据库。SQLite 的 ExperimentalWarning 本身不是这个锁错误的原因。

**停止或重启后如何继续？**

重新发送消息即可唤醒相应成员。异常退出的旧运行会标为待核验，不自动重放；继续前应确认此前文件修改或外部操作的结果。

**升级后为什么行为没变化？**

代码更新后需要重启本地服务。内置 Skill 首次导入后由数据目录中的共享库维护，项目模板更新不会自动覆盖已导入的源码；已有安装需要同步相应 Skill 源码，再发布更新。

**当前有哪些限制？**

本项目仍处于开发阶段，适合本地小规模使用。目前最多 12 个 Agent、3 个并发运行；每轮限制为 16 个模型轮次和 2 美元 SDK 预算，连续运行 30 次后暂停，新用户消息会重置连续次数。费用是 SDK 估算，实际计费以服务商账单为准。成员是否发言由模型判断，不保证每次群消息都有固定数量的回复。

## 开发与测试

```bash
npm run check
```

依次执行前后端类型检查、自动化测试和生产构建，无需付费模型 Key。

常用命令：

| 命令 | 用途 |
| --- | --- |
| `npm run build` | 构建 TypeScript 服务和前端 |
| `npm test` | 运行自动化测试 |
| `npm run smoke:ui` | Chrome 界面验证，不调用模型 |
| `npm run smoke:context-ui` | 会话上下文界面验证 |
| `npm run smoke:inspection` | 会话详情与执行日志界面验证 |
| `npx tsx tests/chat-streaming-smoke.ts` | 私聊流式、群聊显式发送与停止验证 |
| `npm run smoke:context-sdk` | 真实 SDK 配合本地模拟模型验证 |
| `npm run smoke:live` | 使用真实模型验证协作链路，会产生 API 用量 |

界面验证需先构建应用，并安装 Chrome。其他测试入口见 [package.json](package.json)；运行真实模型或 Tavily 测试前，请核实凭据及费用。测试截图与报告保存在 `.raft/`，不进入版本控制。

### 项目结构

```text
src/          SDK 执行、调度、持久化、本地服务与协作 CLI
ui/           React 桌面与网页界面
resources/    内置 Skills、脚本与参考说明
tests/        单元、服务集成、界面和 SDK 验证
docs/         架构设计、实现说明与调研记录
agent.md      开发约定
```

SDK 负责模型调用、工具执行和会话管理；本项目负责消息、调度、版本检查、持久化及界面。Agent 通过 SDK 内置 Bash 调用本地 CLI 协作，当前不接入 MCP。

开发前请阅读 [agent.md](agent.md)，新增能力先核对 [Claude Agent SDK 官方文档](https://code.claude.com/docs/en/agent-sdk/overview)与已安装版本。实现细节见[实现说明](docs/implementation.md)；[多 Agent 设计](docs/multi-agent-design.md)中的候选方案和调研内容不代表已实现功能。
