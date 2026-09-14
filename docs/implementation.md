# 本地助手 v0.1 实现记录

日期：2026-09-14。此文描述已实现代码；此前设计稿仍包含后续功能，不等于全部已交付。

## SDK 核验与选型

当前锁定及安装 `@anthropic-ai/claude-agent-sdk@0.3.267`，开发 Node v24.14.0。实现前重新查询官方文档；Python urllib 返回 403，curl 成功获取 Skills/Plugins，结合此前已经查阅的专题正文和当前安装 sdk.d.ts 逐项核对。

- [TypeScript API](https://platform.claude.com/docs/en/agent-sdk/typescript)：query、Options、SDKMessage、HookCallback、权限回调及 Query.interrupt/close。
- [Sessions](https://platform.claude.com/docs/en/agent-sdk/sessions)：通过明确 session ID 恢复各 Agent 会话。
- [Hooks](https://platform.claude.com/docs/en/agent-sdk/hooks)：PreToolUse、PostToolUse/Failure、PostToolBatch 和 additionalContext。
- [Skills](https://platform.claude.com/docs/en/agent-sdk/skills) 与 [Plugins](https://platform.claude.com/docs/en/agent-sdk/plugins)：显式本地插件分发 Skill，使用 skills 配置及 Skill 内置工具。
- [Permissions](https://platform.claude.com/docs/en/agent-sdk/permissions)：allowedTools 预批准与 canUseTool 回调边界。

模型看到 Read/Glob/Grep/Edit/Write/Bash/Skill。业务能力走 Bash → raftctl → Unix socket → 本地状态机，不配置 MCP。Skill 仅提供命令的渐进说明。SDK 提供循环、执行与会话，业务状态无法仅由 SDK transcript 表达，因此应用实现群成员、任务、inbox、版本和调度。

## 已实现的数据链路

用户输入先经认证的本地 HTTP 命令入库；新消息生成独立接收者记录；调度器合并唤醒并启动一个 SDK Run。工具批次后只提示 inbox 数量。Agent 通过 CLI 拉取、确认、发言、领取或提交任务。活动不生成聊天唤醒，正式消息才生成接收记录。

CLI 进程使用短期 Run 凭据连接本地 socket，服务端查真实身份和有效运行状态。命令 body 不提供发送者身份。写命令必须有 request-id，同身份同 ID 同载荷返回原结果，不同载荷拒绝。新鲜度检查与消息/草稿写入在同一个 SQLite 原子状态更新内完成。

UI 收到 SSE 变化信号后重新读取状态投影，并有低频重连兜底。状态请求按客户端代次过滤迟到响应；恢复采用当前快照，不依赖浏览器保持完整事件历史。CLI 服务与 UI 不共享身份凭据。

每个主身份一个 session，一次 Run 一个输入；result 结束该 Run，finally 关闭 query 并撤销 CLI 凭据。后续输入 resume 同一 session。用户停止先持久化状态，再中断/abort；新消息不能解除停止。退出时收尾本应用 Run 后关闭数据库和 socket，释放服务锁。

## 实际交付范围相对设计稿的收敛

- SQLite 采用单条 JSON 状态记录的原子替换，服务内同步串行命令；不是完整多表事件溯源/outbox 实现。持久化 pending inputs、inbox 与通知代次支持正常运行的合并调度。
- 通知代次记录投递尝试，模型读取和已处理不与它混同。正常恢复允许用户明确继续检查旧未读；跨崩溃提醒不宣称恰好一次。
- 群任务通过 CLI 领取后可在当前 Run 执行。活动固定绑定启动来源；多房间 inbox 合并运行的活动只在独立会话可见，避免随意广播。
- 任务状态为 pending → working → reviewing → done。最后一步由用户手动核验确认；不伪造自动测试证明，不提供尚未实现的 task review 或 dispute CLI。
- 原生只读工具及 raftctl 调用预批准；其他操作由 SDK 权限规则和 canUseTool 回调处理。角色没有“强制只读”沙箱保证。讨论只读快照/全员暂停暂未开放。
- 正常重启后成员停止，用户继续后恢复；异常执行记为未知，不重放旧输入。无法确认旧服务已结束时由 service.lock 阻止第二实例。锁不是完整子进程/外部副作用恢复协议。
- Electron 是开发运行版，使用启动器传入的本机 Node 24 sidecar，尚未打包 Node 或提供签名安装器。

## 验证记录

- `npm run check`：前后端类型、23 个单元/集成用例与构建通过。覆盖旧 CLI、幂等、held draft、已读隔离、游标确认后分页、任务竞争、无权限房间、停止、恢复、socket 身份和服务锁。
- `npm run smoke:ui`：真实本地服务与 Chrome，创建两名 Agent、私聊、群聊、@、创建任务、页面刷新通过，无 pageerror。未使用模拟聊天冒充模型结果。
- 真实模型验证：Atlas 的 SDK session 为 `64e8d713-0d48-4c79-93d7-4f36228adc4c`，Sage 为 `2883d656-09e9-4ad3-a348-8c545264a1fb`。Atlas 用 Skill/Bash/raftctl 提交 SMOKE_PING，Sage 被唤醒后读 inbox、确认并提交 SMOKE_ACK，Atlas 再次使用相同 session ID 恢复并确认已读。模型实际调用只有 Skill/Bash，init 工具列表无 MCP。
- SDK init 的 skills 元数据列出了内置技能及 raft:raft-collaboration；不把这份发现元数据声称为仅显示一个技能。此次实际调用正确加载应用 Skill。
- Electron：真实窗口加载成功，退出后服务结束并释放 service.lock。发现并修复了顶层 await app.whenReady 导致 ESM 入口不能完成初始化的问题。

这些验证证明本地协作路径可运行，不代表已验证多 Agent 并发修改同一代码库、自动审查质量或争议算法。

## CLI 创建子 Agent（2026-09-14）

新增 `agent create/list/status/send`。实现前读取官方 [Subagents](https://platform.claude.com/docs/en/agent-sdk/subagents) 和 [Modifying system prompts](https://platform.claude.com/docs/en/agent-sdk/modifying-system-prompts)，并核对当前 0.3.267 的 `agents`、`systemPrompt`、`resume` 与 `forkSession` 类型。

SDK 原生 `agents` 配置配合 Agent 工具可执行子任务；本次需要的是通过本地 CLI 动态创建、显示在桌面、可独立继续对话的持久身份，因此沿用应用身份调度，每个子成员使用 SDK `query`、独立 session 与后续 `resume`。不开放原生 Agent/SendMessage/ListAgents，不接入 MCP，也不重写 ReAct 循环。专属系统提示词通过 SDK 的 `systemPrompt` 与宿主协作规则组合传入。

创建链路：父 Agent 的 Bash → raftctl → Unix socket 验证活动 Run → 原子保存子身份、真实 parentAgentId、提示词、可选群成员关系和初始输入 → 调度独立 SDK 会话。父身份不从模型参数读取；工作目录由应用自动分配。创建没有任务时不会启动模型；同一 request-id 重试不会重复创建。

结果链路：委派输入记录 replyToAgentId → SDK 返回最终文本或失败 → Run 收尾时保存父会话结果消息与 inbox receipt → 通知父成员。消息含 inputId，以 Run ID 去重。通知可能在当前工具批次后送达，也可能唤醒下一轮。父成员应继续其他工作或结束当前轮，避免轮询占用并发名额。仅返回显式委派结果，不复制子成员其余私聊。

后续 `agent send` 对同一子成员排队，恢复其既有 session；`agent list/status` 仅开放直接子成员，status 提供最近五条委派结果。显式指定 room 时要求父子都属于该群（创建时加入）；默认不入群、不广播结果。父子共用原有 12 个身份、3 个并发等预算。停止父成员不连带停止子成员，停止的子成员接收委派后只排队。

当前结果回传与输入收尾在一次状态更新内保存；进程崩溃后的未知执行仍沿用保守恢复，不承诺跨崩溃自动重放或恰好一次完成。系统提示词是角色指令，不能替代文件系统权限隔离。

本次验证：

- `npm run check`：前后端类型检查、全部 30 个自动化用例、TypeScript/Vite 构建通过。
- 自动化用例覆盖创建幂等、父身份绑定、独立 session、系统提示词、可选入群及权限、全局成员上限、无效任务原子拒绝、文件/stdin 参数、CLI/socket 调度、后续委派 resume、私聊隔离、失败回传与停止状态。
- `npm run smoke:subagents` 真实模型通过：父成员使用 Skill → Read → Bash/raftctl 自行创建 Calculator，子成员按专属系统提示词返回 `CHILD_SYSTEM_MARKER` 和 `42`，父成员被结果唤醒并确认已读。父 session `5fd8c198-f6d4-43a1-b606-8bdbbf36b470` 恢复使用原 ID，子 session `f06d198a-724d-46ff-b1ea-e885877d32fb` 独立。


## 自动创建工作目录（2026-09-14）

创建表单只收集名称和职责。HTTP 和子 Agent CLI 共用创建逻辑：完成参数、权限和幂等检查后，在 `<dataDir>/workspaces/<agent-id>/` 建立实际目录，再持久化身份与可选任务。目录名使用宿主 UUID，重名成员也使用不同目录。创建目录失败时不发布身份或调度任务；重复 request-id 直接返回原结果，不重复分配目录。新成员不接受 workspace 参数。

此改动重新查阅 [TypeScript SDK Options](https://platform.claude.com/docs/en/agent-sdk/typescript)，核实安装版本 0.3.267 的 `cwd?: string` 表示会话工作目录，默认 process.cwd()。继续复用 SDK `cwd`，应用仅负责本地目录分配，不修改 SDK 会话或工具实现。已有 Agent 的路径和文件保留，不自动搬迁；子 Agent 新目录也不复制父工作目录，委派须提供所需项目的绝对路径。独立目录不构成操作系统沙箱。

文件系统 mkdir 和 SQLite 提交不是跨资源事务；进程在两者之间退出可能留下空目录，但不会调度未保存的成员。本版本不自动删除或回收已有工作目录。

验证：`npm run check` 的类型检查、30 个自动化用例和构建通过；`npm run smoke:ui` 通过，确认创建表单没有目录输入框、两名成员目录不同且实际存在。服务测试确认无目录参数的 HTTP 创建成功、子 Agent 的 SDK cwd 已存在、幂等重试不增加目录，以及服务重启后路径与工作文件保留。

## Markdown 消息展示（2026-09-14）

重新查阅 [SDK TypeScript 消息类型](https://platform.claude.com/docs/en/agent-sdk/typescript)，核对 0.3.267 的 SDKAssistantMessage 与文本 content blocks。SDK 继续负责产生消息；Markdown 是应用展示职责，不修改模型调用或已保存的消息正文。

前端使用 [react-markdown](https://github.com/remarkjs/react-markdown)、remark-gfm、remark-breaks 解析，rehype-highlight 为常见代码语言高亮。共享组件覆盖用户/Agent 私聊、群聊、held 草稿和任务证据；支持代码复制，保留聊天换行，表格与代码独立横向滚动。Markdown 模块按需加载，重复状态刷新时复用已渲染的相同文本。

不启用原始 HTML 解析，沿用默认 URL 过滤；桌面新窗口请求只将 HTTP(S)/mailto 交给系统打开，并拒绝应用内新窗口。本地路径只显示，远程图片以链接呈现，不扩展现有图片 CSP。未知语言和未闭合代码块仍显示原文代码。

验证：`npm run check`（类型、30 个自动化用例、构建）、`npm run smoke:ui` 和 `npm run smoke:desktop` 全部通过。浏览器验证标题/引用/列表/任务列表/表格/高亮、复制后的准确代码文本、850px 窗口内横向滚动、未知语言与未闭合代码围栏、HTML/危险链接处理；Electron 验证 Markdown 和系统链接桥接（拦截 shell.openExternal 以避免实际打开网站）、禁止 file 协议及退出清理。人工检查 `.raft/verification/markdown.png` 与 `markdown-code.png` 的实际渲染。

## Skill 自发布与当前 Query 热加载（2026-09-14）

核对官方 [Skills](https://platform.claude.com/docs/en/agent-sdk/skills)、[TypeScript API](https://platform.claude.com/docs/en/agent-sdk/typescript)、本地 0.3.267 的 Query.reloadSkills、SDKControlReloadSkillsResponse、SdkPluginConfig.skipMcpDiscovery 和 Settings.disableBundledSkills。当前 SDK 已提供磁盘重新发现能力，因此不实现自定义 Skill 解释器或工具注册协议。

数据链路：Agent Write/Edit 编写工作目录内的草稿 → Bash/raftctl skill publish → socket 验证 Run 凭据 → SkillManager 校验并复制发布包 → 持久保存发布版本与幂等凭据 → 重建当前成员插件的 Skill 目录投影 → 调用**同一活动 Query** 的 reloadSkills → 检查发现列表与发布列表一致 → 将加载状态返回当前 Bash 工具结果。模型随后以 `raft-local:<name>` 调用原生 Skill，再通过 Bash 执行配套脚本。

宿主为每个 Agent 提前加载一个独立空插件，避免会话启动后再增加未知插件目录。成员之间不共享私有插件。`skills: 'all'` 允许已加载目录中出现新名称；`settingSources: []` 与 `disableBundledSkills: true` 收窄发现来源。基础协作插件和私有插件均设置 skipMcpDiscovery，不开启新的 MCP 接入。

版本文件放在 `<dataDir>/skills/<agent-id>/releases/<sha256>/`，完整写入 staging 后 rename，再把 PublishedSkill 和 request-id 写入 SQLite。托管插件 `plugin/skills/<name>` 以原子切换的符号链接指向发布版本。用户来源包不接受符号链接，宿主仅为受控投影生成链接。每轮 Query 启动前按持久记录修复投影，因此文件发布与数据库之间崩溃可能产生的孤立目录不会自行变为已发布 Skill。历史版本和 staging 暂不自动回收；此机制不是操作系统沙箱。

同一成员的管理命令串行处理，不阻塞其他成员。发布成功与 Query 加载成功分开返回：发布后刷新失败、超时或 Run 停止时，保留持久事实并返回 refresh.status=pending。原 request-id 重试保持原版本；已被新版本替换时 active=false。重试刷新不会恢复已停止的成员，也不会换一个 Query 冒充当前实例热加载。SDK 刷新设 8 秒超时，晚到的控制响应不再改写应用登记。request.status 查询发布凭据，不表示模型已加载或执行。

首次只开放 name/description/argument-hint 和正文；不接受 allowed-tools、hooks、context/agent 或内联 shell 展开，执行权限仍交给现有 SDK 工具策略。格式与目录限制写入 Skill 参考文档，CLI 使用 yaml 解析 frontmatter 而非自行实现 YAML。删除后仅阻止后续发现，无法抹去既有上下文或撤销已执行命令。

已验证：35 个自动化用例覆盖发布、版本更新、幂等、来源校验、跨 Agent 隔离、停止及失败返回、持久恢复；`smoke:skills-sdk` 使用真实 SDK、CLI/socket 在同一个 Query 发布/更新/移除成功，无模型输入且无 MCP。

`smoke:skills-react` 使用本地模拟的 Anthropic 响应驱动真实 SDK 工具链：单个 Query/单个 Run 中 Write 编写 Skill 和脚本 → Bash 发布并等待 reloadSkills → 原生 Skill 加载正文 → Bash 执行输出 42 → 修改同名 Skill 与脚本 → 再发布、再加载新版正文 → 脚本输出 43。分别检查两版正文进入后续模型请求，而非仅检查 Skill 名称列表；也验证了当前 Bash 等待宿主刷新时不会发生相互等待。模型响应在此测试中是模拟的，不将它称为真实模型自主编写结果。

真实供应商验证 `smoke:skills-live` 两次均在 150 秒内没有返回首个工具调用，未到达 Skill 发布步骤；第二次限制了思考预算仍超时，原因尚未确认。对应 session 为 b9d4e604-1c7a-4f4f-9eb9-3dd367723c2a 与 b6205261-991f-4f7b-ac90-6b7cd8aabcd0。保留该脚本供模型端恢复后复验，不把此项记录为通过。Skill 说明的 quick_validate 检查通过。


## 左下角模型设置（2026-09-14）

实现前重新获取官方 [TypeScript API](https://platform.claude.com/docs/en/agent-sdk/typescript)，核对当前安装的 0.3.267 `Options.env` 和 `Options.model`。模型地址和 Key 继续通过 SDK 子进程环境传入，模型名使用原生 model 配置。SDK 不负责本应用的设置界面和持久化，因此仅补充这一层，不改变 Agent 循环、工具或会话管理。

数据链路：左下角设置 → 用户认证的 HTTP GET/POST `/api/settings` → ModelSettings 校验 → 权限 0600 的临时文件原子 rename 为数据目录下 `llm-settings.json` → 更新调度器的应用环境 → 后续 Query 构建时复制环境与模型配置。活动 Query 持有原有配置，不切换其 Key 或模型。保存只通知 UI 刷新，不主动唤醒排队输入；发送消息、继续等既有事件仍按调度规则执行。

应用设置优先于启动环境，未保存时兼容原有 `.env`；单次 CLI 保持原有环境配置路径。API 返回地址、模型、配置来源和 hasApiKey，绝不返回 Key。留空保留 Key，明确清除后持久保存空值；改变地址时要求重新填写或清除 Key。无效输入不修改磁盘或活动配置，JSON 错误也不回显请求内容。配置文件与 SQLite、聊天记录分开，当前为本机明文存储而非钥匙串加密。保存成功仅说明本地持久化成功，不代表服务商连通或模型名称可用。

前端使用原生 dialog 提供焦点约束与 Escape 关闭，Key 默认密码输入，保存后清空输入；提示下次执行生效和当前 Key 状态。侧栏内容单独滚动，设置入口固定在左下方。

验证：`npm run check` 的类型检查、38 个单元/集成用例与构建通过；新增用例覆盖权限、持久恢复、配置优先级、Key 留空/清除/不回显、无效输入、保存不触发执行、运行中更新配置及下一轮生效。`npm run smoke:ui` 使用真实本地服务与 Chrome、替身 runner（不调用外部模型），验证设置入口位置、密码显隐、保存与重开、模型状态更新、错误提示、清除 Key、刷新及 850px 窗口。已检查 `.raft/verification/settings.png` 的实际渲染。


## 群聊 @ 成员候选（2026-09-14）

实现前重新获取官方 [TypeScript API](https://platform.claude.com/docs/en/agent-sdk/typescript)，核对 0.3.267 的 `query` 输入及 SDKUserMessage。候选列表属于本应用的群成员和编辑器交互，继续复用既有消息 → inbox → SDK 输入链路，不修改 SDK 工具、调用协议或群成员权限。

输入组件 MessageComposer 根据光标前的 @ 查询，从当前 room.members 对应的 Agent 中按名称筛选，显示头像、名称、职责摘要和运行状态；不展示其他群成员或在私聊中弹出。列表定位于输入框上方并独立滚动，通过 listbox/option 与 aria-activedescendant 表达键盘选中项。↑/↓ 循环选择，Enter/Tab 补全，Esc 或失焦关闭；无匹配时给出提示，Enter 不会误发。输入法组合期间交给输入法处理，Shift+Enter 保留换行。补全只替换光标前的查询片段，并恢复光标，保留后续正文。邮箱中的 @ 不触发候选。

发送仍使用已有文本与 mentions 成员 ID 字段，服务端继续验证群成员权限，提及不改变普通群消息的投递规则。候选状态在切换会话时重置。成员显示和筛选复用当前状态快照，不额外请求模型。

验证：类型检查、38 项自动化测试和构建，以及 Chrome 界面验证；覆盖列表、大小写筛选、键盘和鼠标选择、光标中间补全、无结果、Esc、换行、输入法事件、邮箱、群成员隔离、私聊和切换会话。输入法使用合成 composition/keydown 事件验证不发送，不宣称覆盖所有操作系统输入法。界面截图 `.raft/verification/mentions.png`。


## SDK 原生 WebSearch 实测（2026-09-14）

为比较联网搜索接入方案，重新读取官方 [TypeScript API](https://platform.claude.com/docs/en/agent-sdk/typescript#websearch)，核对实际安装 0.3.267 的工具白名单与配置。新增 `npm run smoke:search-sdk`，优先读取桌面已保存模型设置，未保存时继承环境配置。只开放原生 WebSearch，不使用 MCP、Tavily 或 Bash 抓网页；临时工作目录、90 秒超时、3 turns、SDK 预算 0.3 美元。不修改应用工具白名单或服务商配置。

真实模型为火山方舟 `doubao-seed-2-0-mini-260428`。约 5.7 秒内初始化成功，工具列表包含 WebSearch，模型确实调用一次查询 Claude Agent SDK 官方 TypeScript 文档。实际工具结果 is_error=true，返回 `403 Access denied for web search. Please go to the Volcano Ark Console to verify the activation status.`，未返回搜索结果。因此不能认定当前原生搜索可用；下一步需用户在火山方舟控制台核验开通状态及权限，然后复测。此结果不能推广为所有兼容模型端点均支持原生搜索。

会话为 `40c6707b-db0e-4e6b-a907-20f8ce5718e8`，脱敏报告 `.raft/verification/search-sdk-live.json`。SDK 报告 total_cost_usd=0.02355，此为 SDK 估算，火山方舟实际费用以账单为准，不能据此判断搜索服务价格。脚本判定必须看到真实 WebSearch 工具结果中的来源 URL，模型声称搜索成功不算通过。

同日 [Tavily 价格页](https://www.tavily.com/pricing)显示免费方案每月 1,000 API credits、无需信用卡，按量付费为 0.008 美元/credit；credit 不等同于所有类型请求都只消耗一次。

本次已执行 `npm run check`，但类型检查被既有 `src/agent.ts:16` 的 SDKUserMessage.uuid 类型不匹配阻断（string 不满足 SDK UUID 模板类型）；本次不修改该会话输入逻辑。真实搜索脚本已执行完成，搜索结论依据运行结果。

## SDK 历史查看与本地执行追踪（2026-09-14）

重新读取官方 [Sessions](https://code.claude.com/docs/en/agent-sdk/sessions)、[Streaming output](https://code.claude.com/docs/en/agent-sdk/streaming-output)、[TypeScript API](https://code.claude.com/docs/en/agent-sdk/typescript) 和 [Observability](https://code.claude.com/docs/en/agent-sdk/observability)，核对安装的 TypeScript SDK 0.3.267、Claude Code 2.1.267。复用 getSessionMessages、includeSystemMessages、SDKUserMessage.uuid、includePartialMessages、SDKAPIRetryMessage、result.modelUsage 和现有工具 Hooks。SDK 提供原生 OTel 导出，但本次目标是内置本地查看器，采用 SDK 已有事件持久化与展示，不额外部署 Collector、不伪造 llm_request span，也不重写 Agent 循环。

`src/history.ts` 通过 SDK 读取并解析已有会话链，应用只做字段投影、工具结果角色识别、输入段编号和分页。HTTP 只允许传入已存在的应用 Agent ID 与该身份当前/采集过的 session ID，cwd 由服务端取成员工作目录；不开放任意目录或全机 SDK 会话枚举。历史按已完成输入消息分段；Skill 与宿主上下文也可能是输入段，不能解释成用户发言数或 API 请求次数。同一模型响应可能拆成多个内容块记录。

每页最多 100 条（UI 40），使用消息 UUID 作为向前分页锚点。由于 SDK 提供的是按偏移分页，且全链分段需要前文，当前由 SDK 读取会话链后计算分段再切页；大型会话仍有读取成本。锚点消失则要求刷新，不静默跳页。角色为 tool 的工具结果通过 tool_use_id 与调用关联；思考内容仅显示实际返回且保存的块。时间戳使用运行时可选字段，缺失则显示未记录。界面 JSON 为经脱敏与规范化的显示结构，非原始网络报文。

`src/trace.ts` 在独立 SQLite 中追加 trace_events，trace_runs 保存每次执行的摘要，trace_messages 保存 SDK 消息 UUID 与 Run 的映射。启动时把未收尾的 running 日志标记 unknown；不改任务执行结果、不重放。运行时为 SDK 输入指定宿主 input UUID，并关联后续 SDK 消息 UUID，因此新记录无需靠时间推算 Run。原有会话的未知关联保持未知。

本地 trace 从宿主 Run 开始，排队/停止/缺少 Key 的状态直接从业务存储投影，不错误归因给 SDK。模型响应开始来自 stream_event/message_start；API 重试来自 system/api_retry；工具参数和返回来自 Pre/PostToolUse，工具往返时间包含授权与 Hook 开销；权限决定来自原有 canUseTool；结果的总耗时、API 累计耗时、turns、modelUsage 与估算成本直接记录，不累加同一 Query 的累计用量。每次应用 Run 只提交一个输入并消费一个结果。

CLI 子任务 Input 保存真实 originRunId，子 Run 继承来源 traceId；应用身份和父子关系由活动 Run 鉴权得出。父子会话仍独立。这里只关联显式 CLI 委派链，普通群消息/inbox 多来源和后续汇总暂不推断为单一父 span。内部 traceId 是本地关联 ID，不宣称 W3C/OTel span ID。

日志通知仅推动 UI 刷新，不调用 scheduler.wake。持久写入失败记录全局日志警告并保留业务执行；读取日志需用户 HTTP token，CLI Agent 凭据没有日志查询能力。日志文件 0600，不记录整个 options.env 或原始 stderr；已知执行 Key/Run token 和凭据字段脱敏后才写入，文本与事件详情限制长度。采集是诊断证据，不是完整审计防篡改系统；没有自动保留期清理。

`ui/AgentInspection.tsx` 提供会话详情与执行日志，独立于原有聊天正文。支持本页/已加载内容搜索、类型/级别筛选、工具与 JSON 折叠、输入到 Run 跳转、父子关联跳转、分页和增量刷新。请求在切换会话或卸载后丢弃迟到结果；轮询串行防止同视图请求重叠。浏览历史不发送模型输入。

验证：新增自动化用例覆盖真实 SDK 读取隔离 JSONL、历史分页/角色/工具关联/脱敏、API 身份与会话范围、查看不唤醒、用量与事件持久化、重启未知状态、父子 trace 与停止、采集失败边界。smoke:inspection 在真实本地服务与 Chrome 中使用展示样例验证交互与窄屏；截图为样例，不冒充真实模型产出。smoke:skills-react 使用真实 SDK 和本地模拟模型运行 10 次工具调用，验证 10 组工具往返日志、模型响应事件、用量、SDK 历史与宿主 input/Run 精确关联。未发起外部模型请求。


## Tavily CLI 与联网搜索 Skill（2026-09-14）

依据前次真实 WebSearch 返回火山方舟 403 的能力边界，本次按用户要求接入 Tavily。重新读取官方 [SDK Skills](https://platform.claude.com/docs/en/agent-sdk/skills)、[Tavily Search](https://docs.tavily.com/documentation/api-reference/endpoint/search) 和 [Extract](https://docs.tavily.com/documentation/api-reference/endpoint/extract)，核对当前 SDK 0.3.267 的本地插件/Skill 发现方式。复用现有原生 Skill、Bash、插件与权限规则，自定义部分只负责 CLI 参数、外部 API 适配和宿主凭据，不重写 Agent 循环，也不接 MCP。

基础插件增加 `raft:tavily-search`，所有桌面成员在后续 Query 中均可发现。链路为 Skill → Bash `raftctl web search/fetch` → Unix socket 校验当前 Run 凭据和活动控制器 → TavilyService → 固定 api.tavily.com HTTPS API → 规范化 JSON → 工具结果。网页正文使用 Tavily Extract，不在宿主实现浏览器或另一套 HTML 抓取器；页面不是可执行指令。

搜索参数限制 query、limit（默认 5，最多 10）、time-range 和 domains；固定 basic/general，不自动升级深度，不请求生成答案。fetch 每次一个公网域名 URL，basic extract，默认输出 12000 字符、最多 30000，返回 truncated 标记。返回标题、链接、摘要/正文、抓取时间，以及供应商提供的 credits。结果中重复链接保留供应商实际结果，最终回答应按来源去重。

Key 独立保存到应用数据目录的 `tavily-settings.json`，本次以原子替换写入且权限 0600；没有文件时回退启动环境的 TAVILY_API_KEY。每次请求重新读取，支持 Key 轮换。服务启动时从传给 Scheduler 的环境副本删除 TAVILY_API_KEY，避免继承到 SDK/Bash；不修改调用者环境。Key 不进入 Skill、项目源码、CLI 参数或结果报告。配置为本地明文，不宣称 OS 钥匙串或强沙箱隔离，当前 LLM 设置 UI 不管理搜索 Key。

请求只发往固定 Tavily 端点，不跟随 API 重定向；25 秒超时、全局最多 3 个在途请求、响应最多 2 MB。运行停止或 CLI 断开会取消请求，不自动重试，已发出的请求仍可能计费。网络工作在异步服务层，SQLite 事务不等待外部 HTTP。搜索不是协作写命令，不支持持久 request-id 幂等或共享缓存，避免误认为重试免费。HTTP 错误不回显供应商原始错误正文；输出字段过滤、长度限制与 Key 脱敏在宿主完成。

验证：`npm run check` 的类型检查、47 项测试和构建通过；Skill quick_validate 通过。新增测试覆盖 CLI 映射、basic 请求参数、凭据来源、SDK 环境不含搜索 Key、结果脱敏、截断、错误响应、无效目标、停止取消以及 socket 身份校验。

`npm run smoke:tavily` 真实模型验证通过：会话 e99be98b-229d-4f37-872e-8041530ac6b4 实际调用 Skill 加载 raft:tavily-search，再调用 Bash/raftctl web search，返回官方 TypeScript SDK 文档链接（供应商返回三条相同 URL，模型如实说明重复）。搜索响应 usage 为 1 credit；独立 CLI/socket basic extract 成功返回正文，本次响应为 0 credits，这不代表所有提取免费。SDK 报告模型估算费用 0.0942 美元，供应商实际费用以账单为准。记录位于 `.raft/verification/tavily-live.json`，不包含 Key。真实测试使用隔离 Agent 和临时数据库，未修改用户会话。

首次部署这些宿主 CLI 命令需重启服务；之后更新 Skill 正文可用既有 reloadSkills 机制，Key 更新在下次请求生效。只热加载 Skill 不会给旧服务增加新的 CLI 命令。


## 会话布局优化（2026-09-14）

本次核对官方 [SDK Sessions](https://code.claude.com/docs/en/agent-sdk/sessions) 与安装版本 0.3.267。继续复用已有 SDK 历史查询与日志采集，修改边界仅为 React 展示层，不新增会话存储或 Agent 循环。

会话顶部压缩为名称和单行职责，完整职责移至状态栏折叠区。右栏提供状态、会话详情、执行日志三个 tab，中间聊天和输入组件持续挂载，因此查看详情不清空草稿或重置聊天滚动。右栏可收起；1100px 以下使用默认收起的侧边浮层，避免挤压聊天。tab 支持方向键/Home/End，Esc 收起后焦点返回状态栏按钮。


## 会话详情密度与排查交互（2026-09-14）

再次核对官方 [Sessions](https://code.claude.com/docs/en/agent-sdk/sessions) 和 [TypeScript getSessionMessages](https://code.claude.com/docs/en/agent-sdk/typescript#getsessionmessages)，以及已安装 0.3.267 的 SessionMessage/getSessionMessages 类型。沿用已有 SDK 历史查询、UUID 分页和脱敏投影，修改仅覆盖会话详情展示与共用轮询 hook，不增加后端存储。

`ui/AgentHistory.tsx` 默认折叠消息，显示角色、短 ID、时间、两行正文摘要与最多四个内容块标记；最新输入段优先，段内维持 SDK 顺序，可切换为最早输入优先。置顶工具栏提供本页匹配计数、失败筛选、批量展开/收起；展开后保留 Markdown、模型、完整 ID、JSON，以及工具参数/结果摘要和折叠正文。支持复制消息 ID 和脱敏 JSON，复制失败有明确反馈。

工具定位只在当前页按唯一 toolId 配对；跳转时清除筛选并展开目标，跨页或歧义不猜测、不标为执行失败。失败计数统计本页含 error 工具结果的记录数，不能代表整个会话所有异常；输入段不等同 API 调用轮次。定时刷新保留展开状态，切页/切换会话重置折叠状态。

验证：`npm run check` 通过类型检查、47 项测试和构建；`smoke:inspection` 覆盖紧凑行高、排序、失败筛选、复制 ID/JSON、工具定位、展开状态跨定时刷新、分页与窄屏，`smoke:ui` 通过聊天、群聊、Markdown 和设置回归。使用隔离展示数据，未请求外部模型。


## 群聊右侧添加成员（2026-09-14）

实现前重新查阅官方 [Subagents](https://platform.claude.com/docs/en/agent-sdk/subagents)，核对安装的 0.3.267 `Options.agents` 与 `resume`。SDK 子代理用于模型委派；现有群聊由宿主状态机维护，添加持久 Agent 到群聊属于应用成员关系操作，因此复用现有 Store/HTTP 命令路径，不新建 SDK 会话或引入 MCP。

右侧成员栏提供「添加成员」，原生 dialog 中多选尚未入群的已有 Agent，展示名称和职责；提交中禁用操作，失败显示错误，全部已加入时提示先创建 Agent。只在群聊中出现入口，加入后成员数量、状态栏和输入框 @ 候选同步刷新。

认证用户的 `room.members.add` 在单次状态事务内校验全部成员后做集合追加；普通 Agent 无此权限。沿用 requestId 幂等，重复添加不产生重复成员或额外版本变化；确有新增时房间版本递增一次，使旧成员快照的草稿继续经过新鲜度检查。成员关系与审计事件持久化，不修改成员的独立会话、工作目录或停止状态，不补投历史消息，不生成新待执行输入；后续群消息使用更新后的成员名单投递。历史消息仍可通过 room.changes 按权限查看。

验证：`npm run check`（48 项自动化测试、前后端类型检查与构建）；新增用例覆盖仅用户可添加、无效成员整批拒绝、去重/重试、房间版本、成员状态保持、无历史补投及后续消息投递。`npm run smoke:ui` 覆盖多选、取消/Escape、过滤已有成员、全部已加入提示、@ 新成员与刷新恢复，截图保存在 `.raft/verification/add-members.png` 和 `room-members.png`。
