# RaftAgent

基于 TypeScript、Claude Agent SDK、React 和 Electron 的多 Agent 本地助手。

每个 Agent 有独立身份、角色、工作目录和 SDK 会话；可以私聊，也可以加入共享群聊。通过 SDK 本地 Bash 调用 `raftctl` 协作，原生 Skill 按需说明命令用法；不接入 MCP。SDK 负责模型调用、工具执行、上下文管理和重试。

## 启动桌面助手

完成下面的依赖安装后：

```bash
npm run desktop
```

命令构建前后端并打开 Electron 窗口。当前是 macOS 开发启动版，依赖本机 Node.js 24+，尚未提供签名安装包。

1. 点击左下角「设置」，填写 API 地址、API Key 和模型名称并保存；然后点击「创建 Agent」，填写名称和职责，应用自动创建本地工作目录。
2. 在独立会话中提交任务，SDK 保存会话；后续输入按 session ID 恢复。
3. 创建协作空间并邀请成员，发送目标或输入 `@`，从当前群成员列表中选择 Agent。继续输入名字可筛选，↑/↓ 切换，Enter/Tab 选中，Esc 关闭；也可鼠标点击。普通消息也进入成员 inbox；活动记录不触发互相回复。
4. 右侧可登记任务、查看成员状态、处理暂存草稿；群聊中点击「成员 → 添加成员」可多选已有 Agent 加入。新成员接收后续消息，历史记录可按需查看。修改文件及一般命令按 SDK 权限规则显示授权请求。
5. 停止后新消息只保存，不自动唤醒。点击「继续」会检查当前状态，不直接重放旧命令。

私聊、群聊、草稿和任务提交说明支持 Markdown：标题、粗体、引用、列表、任务列表、表格、行内代码与代码块。代码块提供常见语言高亮和复制按钮，宽表格与长代码在各自区域横向滚动。网页链接从桌面应用打开到系统浏览器；图片以链接显示，本地文件路径只展示。消息原文仍按文本保存。

无 API Key 也可以管理成员、群聊和查看历史，但不会执行模型。设置保存后从下一次 Agent 执行生效，无需重启；正在运行的任务继续使用原配置。保存操作不测试服务连通性，也不会主动启动排队任务；提交消息或点击「继续」后按调度规则执行。

也可运行本地网页界面：

```bash
npm run web
```

终端输出的启动 URL 包含本地访问凭据，请在自己的浏览器打开，不对外分享。

默认数据位于 `~/Library/Application Support/RaftAgent/raft.sqlite`，可通过 `RAFT_DATA_DIR` 指定。业务数据由本地服务单写，CLI 通过本地 Unix socket 访问。新建成员（含子 Agent）的工作目录为数据目录下的 `workspaces/<agent-id>/`，无需填写；已有成员保留原路径。SDK transcript 仍由 SDK 管理；只复制 SQLite 不等于复制完整模型会话。

## 当前能力与边界

- 已实现：多 Agent 私聊、独立会话恢复、CLI 创建子 Agent 与异步委派、群聊、inbox 与显式确认、合并唤醒、工具活动、任务领取/提交/用户验收、held draft、停止、持久化与基础恢复。
- 任务提交进入「待验收」，由用户核验产物后确认完成；尚未自动运行测试并绑定产物版本。Agent 自述不等于验证通过。
- 首版使用 SQLite 中的一个原子 JSON 状态记录，适合本地小规模验证；最多 12 个身份、3 个并发运行，每轮 16 turns / $2 SDK 预算，连续 30 次运行后暂停，用户继续可重置次数。供应商实际计费以其账单为准。
- 正常重启保留历史并让成员停止，用户明确继续后恢复调度。异常退出的旧输入标记未知，不自动重放；遗留 `service.lock` 会阻止另起实例，核验旧进程与外部操作已停止后再手动移除锁。
- 已发出的外部操作不保证随停止回滚。角色说明和 cwd 不是强文件沙箱，同一 OS 用户下的 CLI 凭据也不是对恶意代码的隔离边界。
- 尚未实现：争议全员暂停/固定快照/投票答询、多写入者工作区隔离、安装包签名与分发。这些仍保留在后续设计中。

## 安装

需要 Node.js 24+ 和 npm。使用 nvm 时可执行 `nvm use`。

```bash
npm ci
```

SDK 通过可选依赖提供本地 Claude Code 二进制文件，请保留可选依赖。常规安装无需另外安装 Claude Code。

## 配置

桌面和网页端推荐通过左下角「设置」配置。API Key 默认隐藏，保存后不回显；留空保留现有 Key，勾选「清除 Key」后保存会移除它。切换 API 地址时需重新填写 Key 或明确清除。

设置保存在数据目录的 `llm-settings.json`，优先于环境变量和 `.env`，不会改写项目 `.env`。Key 与聊天数据库分开保存，文件权限为 `0600`（仅当前系统用户可读写），当前为本地明文文件，未使用系统钥匙串加密。清除已保存的 Key 不会重新启用 `.env` 中的旧 Key。

尚未保存应用设置时，沿用环境变量和 `.env`。原有单次任务 CLI 仍使用环境配置，不读取桌面设置文件。首次使用且项目中没有 `.env` 时：

```bash
cp .env.example .env
```

在 `.env` 中配置服务商信息：

```dotenv
ANTHROPIC_BASE_URL=https://ark.cn-beijing.volces.com/api/compatible
ANTHROPIC_API_KEY=你的火山方舟APIKey
ANTHROPIC_MODEL=你的模型ID或推理接入点ID
```

Claude Agent SDK 使用 Anthropic Messages 协议。`ANTHROPIC_BASE_URL` 必须是兼容接口的基础地址，不能是 `/chat/completions` 或 `/messages` 完整接口。火山方舟必须填写模型 ID 或推理接入点 ID；实际模型和接口支持情况以服务商为准。

使用 Anthropic 官方服务时，只需填写 `ANTHROPIC_API_KEY`；删除或留空 `ANTHROPIC_BASE_URL` 后使用 `https://api.anthropic.com`，`ANTHROPIC_MODEL` 可选。

程序使用 `dotenv` 加载项目根目录的 `.env`，已有环境变量优先。项目沿用本地 `.env`，无需重新填写。模型调用会产生 API 用量。

## Tavily 联网搜索

应用内置 `raft:tavily-search` Skill。可以直接对 Agent 说：「联网搜索 Claude Agent SDK 的最新官方文档，给出来源链接。」Agent 加载 Skill 后使用本地 Bash → raftctl → 宿主 Tavily 服务，不接 MCP，不依赖模型供应商的原生 WebSearch 权限。

```bash
raftctl web search --query 'Claude Agent SDK 官方文档' --limit 5 --json
raftctl web search --query 'Node.js release' --domains nodejs.org --time-range month --json
raftctl web fetch --url 'https://platform.claude.com/docs/en/agent-sdk/overview' --max-chars 12000 --json
```

这些命令在活动 Agent 的 Bash 中使用。默认 basic 搜索，返回标题、URL 和摘要；正文通过 Tavily basic extract 按需读取。搜索最多 10 条，正文最多 30000 字符，truncated 表示被截断。搜索和提取均可能消耗 Tavily credits，返回可用的 usage 信息；不自动重试，不把空结果或抓取失败当作已有证据。

Key 保存在应用数据目录下的 `tavily-settings.json`（`version: 1`、`apiKey` 两个字段），文件权限应为 `0600`；没有该文件时使用启动环境的 `TAVILY_API_KEY`。这是本机明文配置，未使用系统钥匙串。Key 不写进 Skill、源码或 CLI 参数，也不注入桌面 SDK/Bash 环境。每次请求重新读取配置，轮换 Key 无需重启；当前设置面板仍只管理 LLM 配置。

首次更新应用后需重新启动服务以加载新的 CLI 命令。新一轮 Agent 会话会发现基础插件里的 Skill。完整使用说明见 [Tavily Skill](resources/raft-plugin/skills/tavily-search/SKILL.md)。

## Agent 自主创建子 Agent

在桌面成员的对话中提出需要拆分的任务，例如：「创建一个测试审查员，检查登录模块的测试遗漏，把结果汇总给我。」当前 Agent 可以加载协作 Skill，通过本地 Bash 执行：

```bash
raftctl agent create --name '测试审查员' \
  --system-prompt '你负责检查测试覆盖与边界情况，报告实际证据。' \
  --task '阅读登录模块与测试，列出三个最重要的遗漏。' \
  --request-id create-reviewer-001 --json
```

返回的 `data.id` 是子 Agent ID。带 `--task` 自动排队执行；不带则创建空闲成员。长提示词可用 `--system-prompt-file PATH`，任务可用 `--task-file PATH`；`-` 表示从 stdin 读取。

```bash
raftctl agent list --json
raftctl agent status --id CHILD_ID --json
raftctl agent send --id CHILD_ID --task '进一步核验第二项问题。' --request-id followup-001 --json
```

子 Agent 拥有独立持久会话和自动创建的工作目录，沿用应用工具策略，并显示在桌面成员列表。它收到明确的任务文本，不自动获得父会话历史。`--room ROOM_ID` 可让新成员加入创建者已有权限的群聊。

子任务完成或失败后，宿主自动将结果写入父 Agent inbox，父 Agent 可被唤醒继续汇总；无需轮询。停止的成员不会自动恢复。父子生命周期独立，停止父 Agent 不会一并停止子 Agent。

`raftctl` 的路径和当前运行凭据由桌面运行时注入，仅供活动 Agent 的 Bash 使用；普通终端和原有单次 CLI 不具备该身份。写入重试应复用原 `request-id`。完整用法见 [子 Agent Skill 说明](resources/raft-plugin/skills/raft-collaboration/references/agents.md)。

## Agent 自编写与热加载 Skill

Agent 可用本地 Write/Edit 在自己的工作目录中编写 `SKILL.md` 及配套脚本，再通过 CLI 发布。发布成功后使用 SDK 原生 `Query.reloadSkills()` 刷新**当前运行实例**，无需重启应用或结束本轮。

```bash
raftctl skill publish --source ./skill-drafts/count-lines --request-id publish-001 --json
raftctl skill list --json
raftctl skill reload --json
raftctl skill remove --name count-lines --request-id remove-001 --json
```

发布返回 `active=true`、`refresh.status=loaded` 后，Agent 可立即用原生 Skill 工具调用返回的 `raft-local:count-lines`。刷新失败时返回 `pending`，发布文件仍保留，可单独 `skill reload`；`request status` 只证明持久发布状态。修改草稿后需用新 request-id 再次发布，重试原 ID 不会偷偷替换版本。

每个 Agent 只加载自己的发布目录，父子也不自动共享。已发布 Skill 随会话保留，原始草稿修改不直接影响发布文件。发布包只含 Skill 与脚本/参考/资产，不接入 MCP，不改变原有工具授权。移除不清除已读上下文或终止运行中的命令，历史版本文件暂不自动回收。完整格式、示例及限制见 [Skill 热加载说明](resources/raft-plugin/skills/raft-collaboration/references/skills.md)。

## 原有单次 CLI

开发运行：

```bash
npm run dev -- "用三句话介绍一下你自己"
npm run dev -- "读取 src/agent.ts，解释这个 Agent 的执行流程"
```

编译后运行：

```bash
npm run build
npm start -- "介绍一下当前项目"
```

`npm run dev -- --help` 查看帮助。请用引号传入一个非空任务。无论从哪个目录启动入口，Agent 工作目录与 `.env` 路径均固定为项目根目录。

按 Ctrl+C 通过 SDK 的 `abortController` 取消执行，结束时通过 `Query.close()` 清理子进程。退出码：成功为 `0`，配置或执行失败为 `1`，参数错误为 `2`，用户中断为 `130`。

## 工具与设置

- 原有单次 CLI 只开放 `Read`、`Glob`、`Grep`。桌面运行时增加 SDK 内置 `Edit`、`Write`、`Bash`、`Skill`，保留权限回调；协作 CLI 与只读工具按配置预批准。
- `settingSources: []` 不加载用户、项目和本地 Claude Code 设置文件。SDK 的托管策略仍按官方规则生效。
- `strictMcpConfig: true` 和空 `mcpServers` 避免自动接入项目 `.mcp.json`、用户或插件中的 MCP 服务。项目 `.mcp.json` 可供开发工具使用，不会被本应用加载。
- 应用显式加载 `resources/raft-plugin` 和当前 Agent 的托管 Skill 插件；两者均使用 `skipMcpDiscovery`，不包含 MCP。使用 `skills: 'all'` 接纳目录中的新增 Skill，同时关闭 bundled skills、保持 `settingSources: []`，避免固定名称过滤阻止热加载。模型看到的协作入口是 `raftctl`。
- 提示词要求不读取凭证。工作目录和提示词均不是文件系统安全沙箱，当前实现不提供敏感文件的强制隔离。

## 项目结构

多 Agent 功能的已确认要求、分叉讨论方案与待决策边界维护在 [本地多 Agent 协作设计](docs/multi-agent-design.md)。后续开发需先对齐该文档，并按 [agent.md](agent.md) 核查 SDK 能力；文档中的候选方案不代表已经确定或实现。

相关开源项目的源码、测试与复用边界见 [多 Agent GitHub 项目调研](docs/multi-agent-github-research.md)。调研建议与已确认设计分开维护。

```text
src/
  cli.ts          单次运行 / serve / ctl 输入输出
  config.ts       配置校验和 SDK Options
  model-settings.ts 本地模型设置持久化、校验与 Key 脱敏
  agent.ts        SDK 单次与流式会话执行
  runtime.ts      单实例调度、Hooks、权限请求、session 关联
  store.ts        显式状态转换、命令幂等、SQLite 持久化
  server.ts       本地 HTTP UI 与 Unix socket 命令服务
  control.ts      raftctl 参数与本地连接
  skills.ts       Skill 发布校验、版本文件、持久登记、SDK 热刷新
  tavily.ts       Tavily 搜索与正文提取、凭据读取、超时和结果规范化
  desktop.ts      Electron 窗口与服务进程生命周期
  launch.ts       使用 Node 24 启动桌面应用
ui/               React 界面
resources/        本地 Skill 及参考说明
tests/            单元、服务集成、UI、Electron 与真实 SDK 验证
agent.md          开发约定：实现前查文档，SDK 优先
AGENTS.md         项目指令入口
```

## 验证

```bash
npm run check
```

此命令依次执行前后端类型检查、无需 API Key 或网络的自动化测试，以及 TypeScript/Vite 构建。

```bash
npm run smoke:ui       # Chrome 验证聊天、Markdown、模型设置与刷新；不调用模型
npm run smoke:desktop  # Electron 启动、界面和退出清理（先 build）
npm run smoke:live     # 使用 .env 的真实模型验证 Skill → Bash → CLI → 群消息 → 唤醒/恢复
npm run smoke:subagents # 使用真实模型验证自主创建 → 独立子会话 → 结果回传与确认（先 build）
npm run smoke:tavily   # 真实模型加载 Skill → Bash/CLI 搜索，并验证 Tavily 正文提取（先 build）
npm run smoke:search-sdk # 当前桌面有效配置验证原生 WebSearch，会产生模型用量
npm run smoke:skills-sdk # 真实 SDK 控制通道验证发布/更新/移除，无模型输入
npm run smoke:skills-react # 本地模拟模型响应 + 真实 SDK，验证当前 ReAct 循环中发布与更新
npm run smoke:skills-live # 真实模型同一轮自编写 → 发布 → 加载 → 本地脚本执行（先 build）
```

真实验证会产生 API 用量，使用临时工作目录；结果报告路径由脚本输出。UI 截图保存在 `.raft/verification/`，不进入版本控制。

## SDK 使用依据

本实现对照[官方快速开始](https://code.claude.com/docs/zh-CN/agent-sdk/quickstart)、[TypeScript API 参考](https://code.claude.com/docs/zh-CN/agent-sdk/typescript)和安装版本的类型声明，使用 `query`、`Options`、`SDKMessage`、`abortController`、`Query.close()` 完成执行和生命周期管理。具体版本见 `package.json` 与 `package-lock.json`。

自定义代码处理本地应用状态、会话调度、CLI 与 UI 集成，未重写 SDK Agent 循环或上下文管理。实现取舍、官方链接与验证记录见 [实现说明](docs/implementation.md)。新增能力前，继续按 [agent.md](agent.md) 核查 SDK 支持情况。

[火山方舟 Messages API 文档](https://www.volcengine.com/docs/82379/2655179)

## 会话详情与执行日志

打开任意 Agent 的独立会话，在右侧状态栏切换「状态 / 会话详情 / 执行日志」。中间始终保留聊天和输入框，切换右侧 tab 不会清空草稿。顶部职责仅显示一行，完整内容可在「状态 → 职责说明」展开查看。点击「状态栏」可收起或展开右栏；窄窗口默认收起，展开后以侧边浮层显示，也可按 Esc 收起：

- **会话详情**：使用 SDK 原生历史查询读取输入、模型输出、供应商返回的思考块，以及工具参数与结果。默认以紧凑摘要展示角色、时间、消息 ID 和工具标记，最新输入段在前、段内保持原顺序。支持选择已关联会话、每页 40 条记录、类型/失败筛选、本页搜索、批量展开/收起、工具调用与结果互相定位、复制消息 ID 或脱敏 JSON。每 3 秒刷新当前页；SDK 写入完整内容块后可见，不提供逐 token 的正文动画。
- **执行日志**：显示排队数量和等待原因；新执行自动记录 SDK 初始化、模型开始返回、API 重试、上下文压缩、工具往返、授权等待与决定、执行结果和取消。可按级别或文本筛选，查看用量和 SDK 估算费用；详情每 2 秒增量读取，每批最多 200 条事件。
- 新运行用输入 UUID 和 SDK 消息 UUID 关联 Run，可从历史详情跳转到对应执行。CLI 创建/委派子 Agent 时保留来源 Run，同一委派链的执行可以相互跳转。普通群聊合并唤醒暂不推算多来源 trace 关系。

SDK 历史仍由 SDK 自己保存；本地执行日志另存于数据目录的 `traces.sqlite`，不写入聊天消息，也不会因查看日志而启动 Agent。旧运行没有采集的耗时、重试与用量不会事后补造。未收尾的日志在服务重启后标记「待核验」。日志独立于任务结果；日志写入失败会显示提示，不改变任务调度。

这是基于 SDK 消息和 Hooks 的本地执行追踪，当前不启动 OTel Collector，也不导出到第三方服务。模型响应开始事件表示收到响应，不等于准确的 HTTP 发出时间；工具往返耗时包含授权等待。费用为 SDK 本地估算，第三方模型以服务商账单为准。

记录只供本地用户认证接口读取，已知当前密钥和常见凭据字段会脱敏，二进制与签名不展开；长文本和过多条目有截断提示。原始 SDK 文件不被改写，原文件仍可能含工具处理过的敏感内容。日志目前持续保留，无自动清理。界面中的 JSON 是脱敏后的展示结构，不是完整 API 请求报文。

验证命令：`npm run smoke:inspection`（先构建）。真实 SDK 与本地模拟模型的完整工具链验证包含在 `npm run smoke:skills-react`，无需外部模型 Key。
