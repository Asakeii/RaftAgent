# 多 Agent 协作 GitHub 项目调研

调研日期：2026-09-11。范围：为 [本地多 Agent 协作设计](multi-agent-design.md) 寻找可借鉴的工程机制。本文是调研结论及候选建议，不新增已确认决策，不启动功能实现。

后续决策说明：本文保留调研时的建议状态；用户随后已确认 Q20（D35）：全员暂停并记录各自完整可恢复位置后，才创建讨论 fork。下文涉及 Q20 尚未确认的表述属于调研时快照，最新规则及后续未决问题以设计文档为准。

## 1. 结论与选型定位

在本次检查的仓库和代码路径中，没有发现完整覆盖“全应用主世界成员暂停 → 原上下文只读分叉 → 固定候选独立投票 → 无建议提前恢复 → 平票再投一轮 → 用户裁决 → 协调状态写入后恢复”的现成实现。

最值得组合参考的是：

- **Agent Mail**：消息正文与收件人状态分离、读取与确认分离、轻量通知。
- **Agent Orchestrator**：执行者与审查者协作、进程身份与会话身份分离、通知门禁和重启恢复。
- **oh-my-claudecode**：TypeScript 本地多 Agent 调度、任务领取、投递状态和恢复测试。
- **LangGraphJS**：持久化检查点、人工等待、状态分支与重放边界。
- **AutoGen**：多轮意见汇总的教学样例，以及合作式暂停的能力边界。
- **官方 Claude Agent SDK demos**：持续输入与会话管理的接线示例。

建议保留本项目 Claude Agent SDK 执行基础；从上述项目提取状态模型、并发约束和测试场景，不直接引入另一套 Agent 执行循环。是否采用 SQLite、worktree 等仍是候选，须后续确认。讨论与投票规则也不能因外部项目采用不同机制而自动改变。

## 2. 筛选方法与质量边界

通过 GitHub 仓库搜索初筛消息、多 Agent 编码、讨论投票类项目，再检查固定提交的源码、测试、维护状态和许可证。Stars 只作为发现线索，不作为正确性证明。

本次没有运行这些外部仓库的程序或测试，没有调用模型验证它们的实际协作效果。下文“测试覆盖”表示读取到了相应测试代码，不表示本次执行通过。维护与 Stars 是调研时快照；固定提交链接用于后续复查。

| 项目 | Stars 约数 | 维护 / 技术栈 | 本项目参考价值 | 采用边界 |
| --- | ---: | --- | --- | --- |
| [Untrivial-ai/agent-orchestrator](https://github.com/Untrivial-ai/agent-orchestrator) | 11,368 | 活跃；当前 Go 后端；Apache-2.0 | 编码—审查—纠正、身份、通知与恢复 | 原 ComposioHQ 地址已重定向；旧 TypeScript 后端介绍不代表当前代码 |
| [Yeachan-Heo/oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode) | 39,091 | 活跃；TypeScript；MIT | 本地调度、任务领取、恢复并发测试 | 核心运行方式含 tmux/cmux，不是纯 SDK 嵌入库 |
| [Dicklesworthstone/mcp_agent_mail](https://github.com/Dicklesworthstone/mcp_agent_mail) | 2,135 | 活跃；Python / FastMCP / SQLite / Git | 最接近 inbox 的数据与通知模型 | 自定义限制性许可，不能当标准 MIT 依赖；当前 CI 有失败记录 |
| [langchain-ai/langgraphjs](https://github.com/langchain-ai/langgraphjs) | 3,270 | 活跃；TypeScript；MIT | 检查点、等待用户、分支、恢复测试 | 图状态分支不是 SDK 会话或文件快照 |
| [microsoft/autogen](https://github.com/microsoft/autogen) | 60,929 | 维护模式；所查模块为 Python；代码 MIT | 轮次缓冲、意见汇总、暂停反例 | 不再新增功能；debate 是教学样例，不是完整投票协议 |
| [anthropics/claude-agent-sdk-demos](https://github.com/anthropics/claude-agent-sdk-demos) | 2,735 | 官方 TS / Python 示例 | SDK 原生会话接线 | 仓库根目录未见统一 LICENSE，不能笼统认定全仓 MIT；示例版本需核对 |

### 固定源码版本

| 简称 | Commit |
| --- | --- |
| AO | `4ad71cc24d965ee42a812db83bbb9e3b0eda2353` |
| OMC | `4820f5641828cb980b7eb488a3c187f3d01459c3` |
| Mail | `ac4966c64d7e39692a4fb9c707448a1718ab29db` |
| LangGraphJS | `a97e6f4eaf8683cd67002bc42cf8dddf5255e29d` |
| AutoGen | `027ecf0a379bcc1d09956d46d12d44a3ad9cee14` |
| SDK demos | `826b268506a5f3707623c9e6140b200befcbebae` |

## 3. Agent Mail：先学消息状态的拆分

**代码事实。** [Message / MessageRecipient 模型](https://github.com/Dicklesworthstone/mcp_agent_mail/blob/ac4966c64d7e39692a4fb9c707448a1718ab29db/src/mcp_agent_mail/models.py#L58-L109) 把消息正文与收件人状态拆开，分别保存 `read_ts` 和 `ack_ts`。[fetch_inbox](https://github.com/Dicklesworthstone/mcp_agent_mail/blob/ac4966c64d7e39692a4fb9c707448a1718ab29db/src/mcp_agent_mail/app.py#L9592-L9636) 拉取消息；[read / acknowledge](https://github.com/Dicklesworthstone/mcp_agent_mail/blob/ac4966c64d7e39692a4fb9c707448a1718ab29db/src/mcp_agent_mail/app.py#L9843-L9939) 另行登记，确认会同时标已读。[条件更新](https://github.com/Dicklesworthstone/mcp_agent_mail/blob/ac4966c64d7e39692a4fb9c707448a1718ab29db/src/mcp_agent_mail/app.py#L5003-L5045) 避免重复请求覆盖首次时间。

[信号文件](https://github.com/Dicklesworthstone/mcp_agent_mail/blob/ac4966c64d7e39692a4fb9c707448a1718ab29db/src/mcp_agent_mail/storage.py#L3604-L3681) 与 [PostToolUse hook](https://github.com/Dicklesworthstone/mcp_agent_mail/blob/ac4966c64d7e39692a4fb9c707448a1718ab29db/scripts/hooks/check_inbox.sh#L1-L33) 提供轻量提醒。[拉取后清理信号](https://github.com/Dicklesworthstone/mcp_agent_mail/blob/ac4966c64d7e39692a4fb9c707448a1718ab29db/src/mcp_agent_mail/app.py#L9676-L9688) 不等于所有消息已读；信号不是可靠未读计数。

**对当前设计的启发。** “未新增 / 新增消息 / @ 消息”适合作为派生展示，不足以承载全部业务状态。消息已保存、提醒已发出、正文已读取、@ 已裁决、任务已完成需要分开记录。讨论 fork 读取证据时，也不应顺手推进原 Agent 的读取进度；这是本项目需确定的隔离约束。

**不要照搬的部分。**

- 文件预约是协作约定，不是排他锁。[并发测试](https://github.com/Dicklesworthstone/mcp_agent_mail/blob/ac4966c64d7e39692a4fb9c707448a1718ab29db/tests/test_concurrency_agents.py#L284-L337) 允许竞争者都拿到预约，不能据此保证不同时写文件。
- Git 与 SQLite 双写不构成单个事务。[Git 失败后的补偿删除](https://github.com/Dicklesworthstone/mcp_agent_mail/blob/ac4966c64d7e39692a4fb9c707448a1718ab29db/src/mcp_agent_mail/app.py#L5668-L5699) 说明仍需处理部分完成。
- [灾难恢复测试](https://github.com/Dicklesworthstone/mcp_agent_mail/blob/ac4966c64d7e39692a4fb9c707448a1718ab29db/tests/test_e2e_disaster_recovery.py#L411-L440) 注明恢复后可能因旧 Git 引用导致写失败，所检验的可读恢复不能扩大为完整可写恢复。
- [LICENSE](https://github.com/Dicklesworthstone/mcp_agent_mail/blob/ac4966c64d7e39692a4fb9c707448a1718ab29db/LICENSE) 含 OpenAI / Anthropic Rider，对相关主体及提供软件访问施加额外限制；不是标准 MIT。本次不建议直接复制代码或添加依赖。
- 抽查该提交及最近三次 CI 均显示失败，[其中一次记录](https://github.com/Dicklesworthstone/mcp_agent_mail/actions/runs/34013153572)。没有定位失败原因，因此不能由此断言业务机制有缺陷，也不能宣称当前主线验证通过。

## 4. Agent Orchestrator：最值得参考编码协作的运行控制

**代码事实。** [Session 模型](https://github.com/Untrivial-ai/agent-orchestrator/blob/4ad71cc24d965ee42a812db83bbb9e3b0eda2353/backend/internal/domain/session.go#L25-L71) 区分应用 Session、Agent 原生会话、运行启动和 controller generation。旧控制器的迟到事件不能更新新的会话代次。

[输入门禁](https://github.com/Untrivial-ai/agent-orchestrator/blob/4ad71cc24d965ee42a812db83bbb9e3b0eda2353/backend/internal/sessionguard/guard.go#L1-L74) 检查目标生命周期，并以输入租约避免“检查时可写、真正发送时已退出”的竞态。[审查反馈投递](https://github.com/Untrivial-ai/agent-orchestrator/blob/4ad71cc24d965ee42a812db83bbb9e3b0eda2353/backend/internal/lifecycle/reactions.go#L48-L131) 保存反馈签名与尝试次数，被门禁拦截的发送不会标成已投递。

**对应你的首个验收场景。** 可以参考它将审查反馈重新送给执行者的闭环，而不是只验证多 Agent 相互发消息。[自动审查协调器](https://github.com/Untrivial-ai/agent-orchestrator/blob/4ad71cc24d965ee42a812db83bbb9e3b0eda2353/backend/internal/autoreview/coordinator.go#L15-L38) 有明确触发与有限重试。[worktree 管理](https://github.com/Untrivial-ai/agent-orchestrator/blob/4ad71cc24d965ee42a812db83bbb9e3b0eda2353/backend/internal/adapters/workspace/gitworktree/workspace.go#L71-L130) 可供后续执行者文件隔离参考。

**恢复边界。** [发送与持久化顺序](https://github.com/Untrivial-ai/agent-orchestrator/blob/4ad71cc24d965ee42a812db83bbb9e3b0eda2353/backend/internal/lifecycle/reactions.go#L961-L1026) 明确容许在发送成功、持久化失败后重启时重复通知。消息记录一次与模型恰好收到一次不是同一个保证。本项目已确认的同轮投票幂等，也不能自动推出任务操作恰好执行一次。

**与讨论 fork 的区别。** [Reviewer 启动器](https://github.com/Untrivial-ai/agent-orchestrator/blob/4ad71cc24d965ee42a812db83bbb9e3b0eda2353/backend/internal/review/launcher.go#L33-L106) 创建独立 reviewer runtime，但复用 worker worktree，不能当作原执行者上下文和文件的只读快照。

**质量证据。** 有 [重启反馈去重测试](https://github.com/Untrivial-ai/agent-orchestrator/blob/4ad71cc24d965ee42a812db83bbb9e3b0eda2353/backend/internal/lifecycle/manager_test.go#L2948-L2996)、[门禁关闭测试](https://github.com/Untrivial-ai/agent-orchestrator/blob/4ad71cc24d965ee42a812db83bbb9e3b0eda2353/backend/internal/sessionguard/guard_test.go#L335-L350)，[CI 配置](https://github.com/Untrivial-ai/agent-orchestrator/blob/4ad71cc24d965ee42a812db83bbb9e3b0eda2353/.github/workflows/go.yml#L17-L87) 包含 build、vet、race 测试和部分平台专项验证。本次只核验其存在，未执行或认定当前全绿。

## 5. oh-my-claudecode：与本项目语言接近的本地调度实现

**投递状态。** [dispatch-queue](https://github.com/Yeachan-Heo/oh-my-claudecode/blob/4820f5641828cb980b7eb488a3c187f3d01459c3/src/team/dispatch-queue.ts#L490-L533) 明确维护 pending、notified、delivered、failed，并在锁内检查重复请求后保存。提醒已发送与投递完成分开。

**任务归属。** [claimTask](https://github.com/Yeachan-Heo/oh-my-claudecode/blob/4820f5641828cb980b7eb488a3c187f3d01459c3/src/team/state/tasks.ts#L58-L116) 在锁内重新读取任务、检查版本与已有归属，写入 claim token、lease 和递增版本。[后续状态转换](https://github.com/Yeachan-Heo/oh-my-claudecode/blob/4820f5641828cb980b7eb488a3c187f3d01459c3/src/team/state/tasks.ts#L171-L232) 检查令牌和到期时间。它解决谁能更新任务，不能代替谁有投票席位。

**独立判断。** [ralplan 工作流](https://github.com/Yeachan-Heo/oh-my-claudecode/blob/4820f5641828cb980b7eb488a3c187f3d01459c3/skills/ralplan/SKILL.md#L43-L65) 要求 Architect 和 Critic 独立审查相同固定计划，不把 Architect 结果传给 Critic，之后由 Planner 汇总。这支持“独立评估相同输入”这个方向。但该部分是提示词工作流，且是角色审查与修订循环，不是宿主强制的一身份一票、弃权或两轮计票。

**质量证据。** [投递存储严格读取测试](https://github.com/Yeachan-Heo/oh-my-claudecode/blob/4820f5641828cb980b7eb488a3c187f3d01459c3/src/team/__tests__/dispatch-queue.strict-read.test.ts#L87-L155) 区分缺失、损坏、无效状态和缺少 message ID；[恢复预约测试](https://github.com/Yeachan-Heo/oh-my-claudecode/blob/4820f5641828cb980b7eb488a3c187f3d01459c3/src/team/__tests__/recovery-reservation-claim.test.ts#L67-L91) 检查普通领取冲突、错误 generation/token 以及重复恢复。这些失败场景比功能清单更有借鉴价值。

**复用边界。** 当前 runtime 包含 tmux/cmux 进程控制；[SDK 依赖](https://github.com/Yeachan-Heo/oh-my-claudecode/blob/4820f5641828cb980b7eb488a3c187f3d01459c3/package.json#L91) 为 `^0.1.0`，与本项目 `0.3.267` 不同。可参考 TS 状态组织与测试，不应直接搬入整套运行器或沿用旧 SDK 接口假设。

## 6. LangGraphJS：持久化“下一步做什么”，而不只是聊天记录

**代码事实。** [Checkpoint 定义](https://github.com/langchain-ai/langgraphjs/blob/a97e6f4eaf8683cd67002bc42cf8dddf5255e29d/docs/docs/concepts/persistence.md#L1-L23) 包括状态、后续节点和任务等信息。[SQLite 存储](https://github.com/langchain-ai/langgraphjs/blob/a97e6f4eaf8683cd67002bc42cf8dddf5255e29d/libs/checkpoint-sqlite/src/index.ts#L99-L137) 使用 WAL、复合主键；[保存逻辑](https://github.com/langchain-ai/langgraphjs/blob/a97e6f4eaf8683cd67002bc42cf8dddf5255e29d/libs/checkpoint-sqlite/src/index.ts#L383-L438) 保留父检查点关联。

[interrupt 实现](https://github.com/langchain-ai/langgraphjs/blob/a97e6f4eaf8683cd67002bc42cf8dddf5255e29d/libs/langgraph-core/src/interrupt.ts#L63-L112) 把等待外部输入建模为明确中断，并通过 resume 值继续。它可启发“等待用户裁决”的持久状态，但不是本项目用户显式“停止”的独立中断通道，两者语义不同。

**对当前设计的启发。** 重启时需要恢复讨论轮次、已收票、等待用户状态、暂停归属和并发名额；只有消息列表与 SDK session ID 无法判断下一步应该补票、继续等待还是应用裁决。具体存储结构尚待设计。

**fork 与恢复边界。** [独立分支测试](https://github.com/langchain-ai/langgraphjs/blob/a97e6f4eaf8683cd67002bc42cf8dddf5255e29d/libs/langgraph-core/src/tests/time_travel_extended.test.ts#L109-L135) 验证图状态分支互不污染，但不涉及 Claude SDK 进程或文件隔离。[恢复测试](https://github.com/langchain-ai/langgraphjs/blob/a97e6f4eaf8683cd67002bc42cf8dddf5255e29d/libs/langgraph-core/src/tests/time_travel_extended.test.ts#L29-L56) 表明检查点之后的节点会重新执行，不能宣称恢复自动避免外部操作重复。

[SQLite 测试](https://github.com/langchain-ai/langgraphjs/blob/a97e6f4eaf8683cd67002bc42cf8dddf5255e29d/libs/checkpoint-sqlite/src/tests/checkpoints.test.ts#L47-L160) 涉及保存、读取和 interrupt/resume writes。即使这些存储机制可用，“迟到票取消询问”和“用户提交已被记录”的互斥仍需本项目自己的业务状态转换。

## 7. AutoGen：借鉴轮次组织，仔细区分教学投票与正式协议

仓库 [README](https://github.com/microsoft/autogen/blob/027ecf0a379bcc1d09956d46d12d44a3ad9cee14/README.md#L14-L25) 明确处于 maintenance mode，不再新增功能，并推荐新用户考虑 Microsoft Agent Framework。未归档不等于持续功能开发。[代码许可证](https://github.com/microsoft/autogen/blob/027ecf0a379bcc1d09956d46d12d44a3ad9cee14/LICENSE-CODE#L1-L21) 为 MIT，不应把文档的 CC-BY-4.0 元数据套用到代码。

**讨论样例。** [multi-agent debate](https://github.com/microsoft/autogen/blob/027ecf0a379bcc1d09956d46d12d44a3ad9cee14/python/docs/src/user-guide/core-user-guide/design-patterns/multi-agent-debate.ipynb#L194-L217) 按轮缓冲邻居响应，再生成下一轮输入；[Aggregator](https://github.com/microsoft/autogen/blob/027ecf0a379bcc1d09956d46d12d44a3ad9cee14/python/docs/src/user-guide/core-user-guide/design-patterns/multi-agent-debate.ipynb#L247-L277) 收齐回答后统计答案。

样例使用自由生成答案、预设轮数和 `max(set(answers), key=answers.count)`。它没有完整定义身份去重、同轮不可改票、固定候选、无建议退出、平票处理、缺票超时及用户裁决竞争，因此不能直接作为本项目的计票实现。

**暂停是本次最有价值的边界发现。** [pause 文档](https://github.com/microsoft/autogen/blob/027ecf0a379bcc1d09956d46d12d44a3ad9cee14/python/packages/autogen-agentchat/src/autogen_agentchat/teams/_group_chat/_base_group_chat.py#L657-L680) 依赖各 Agent 的 `on_pause`，未实现可为 no-op；[save_state 文档](https://github.com/microsoft/autogen/blob/027ecf0a379bcc1d09956d46d12d44a3ad9cee14/python/packages/autogen-agentchat/src/autogen_agentchat/teams/_group_chat/_base_group_chat.py#L773-L777) 明确运行中保存不保证一致。[测试](https://github.com/microsoft/autogen/blob/027ecf0a379bcc1d09956d46d12d44a3ad9cee14/python/packages/autogen-agentchat/tests/test_group_chat_pause_resume.py#L89-L136) 通过实现合作式暂停验证计数停止。

这支持继续澄清当前 Q20：“请求暂停”与“已到达可恢复边界”需要区别。全员暂停确认后再创建 fork 是候选建议，尚未被用户确认；即使采用，也不自动冻结外部进程或之后恢复工作的无建议 Agent 所能修改的文件。

## 8. 官方 SDK demos：用于校对接线，不当作完整编排器

[simple-chatapp AgentSession](https://github.com/anthropics/claude-agent-sdk-demos/blob/826b268506a5f3707623c9e6140b200befcbebae/simple-chatapp/server/ai-client.ts#L17-L106) 展示异步输入队列与持续 `query()` 输出；[应用 Session](https://github.com/anthropics/claude-agent-sdk-demos/blob/826b268506a5f3707623c9e6140b200befcbebae/simple-chatapp/server/session.ts#L5-L54) 将前端订阅与 AgentSession 分开。队列在内存中，不能作为本地 durable inbox。

[V2 示例](https://github.com/anthropics/claude-agent-sdk-demos/blob/826b268506a5f3707623c9e6140b200befcbebae/hello-world-v2/v2-examples.ts#L87-L125) 展示恢复原会话，不是隔离 fork。该聊天示例的 [依赖版本](https://github.com/anthropics/claude-agent-sdk-demos/blob/826b268506a5f3707623c9e6140b200befcbebae/simple-chatapp/package.json#L6-L22) 为 `^0.1.28`，不能直接当作本项目安装版本的 API 证明。

实施时仍依 [agent.md](../agent.md) 查官方会话、权限、Hooks、自定义工具文档及当前类型。现有设计文档第 8 节记录的 SDK 能力核验继续有效，但本次仓库阅读没有补充真实模型运行验证。

## 9. 对当前设计的具体建议与待确认边界

以下均为调研建议，不修改 D01–D34。

| 设计点 | 建议借鉴 | 保留的待决策边界 |
| --- | --- | --- |
| inbox 三档展示 | Mail 的正文与收件人状态分离；OMC 的投递状态分离 | 什么动作推进读取位置、分页如何确认、fork 读取是否完全独立 |
| 运行身份 | AO 的应用身份、原生会话、运行代次分开 | 应用成员注册/退出；旧进程迟到结果处理；fork 与席位关联 |
| 全员暂停 | 区分请求、到达边界、可恢复位置已记录 | Q20 的 barrier；某成员无法暂停或恢复时如何处理 |
| 独立判断 | OMC 的固定输入独立审查、AutoGen 的按轮收齐 | 工具也需限制跨房间/本轮票可见性；不能仅靠提示词要求独立 |
| 答询分身 | 来源会话与分身会话显式关联，查询已存证据 | 使用哪个时间点的快照、问答次数/超时、是否缓存；答询不得向其他投票者泄露本轮选择 |
| 用户与迟到票 | 明确等待状态，原子接受一个最终来源 | 已记录用户裁决优先的提交/取消互斥、过期 UI 提交反馈 |
| super agent 应用结果 | 持久化决定、任务安排、原 @ 状态及结果通知，再释放本场暂停 | 是否由 super agent 产出结构化计划、宿主事务提交；失败重试的幂等键 |
| 并行讨论与重启 | 恢复状态机和每场暂停归属 | 两场都等待用户仍占两席；重启不可重新分配席位或重复解除暂停 |
| 编码冲突纠正 | AO 的审查结果回流；OMC 的任务归属机制 | 共享目录还是 worktree、合并由谁负责；会话 fork 不替代文件隔离 |

尤其需要在后续区分三件事：

1. **原会话不受污染**：讨论与答询的新消息没有进入原 SDK 会话。
2. **讨论证据固定**：fork 所读文件/任务记录是否来自固定版本，仍待决定；原会话 fork 本身不提供这个保证。
3. **协调记录一致**：结果、任务和通知部分写入失败时如何恢复，是存储问题。它与用户已明确移除的“自动判断裁决语义失效并重开”不同，不应重新引入后者。

## 10. 后续最有价值的验证场景

沿用已确认的真实编码任务验收。建议先选择一个行为冲突清晰的小任务，例如：A 实现参数校验，B 审查时发现与用户指定兼容行为冲突，B @ A，接收方判断冲突后触发讨论；按裁决更新任务，再观察负责 Agent 是否实际修改代码并使行为测试通过。具体任务需后续选择。

配套的协议测试候选：

- 同一身份重复提交相同票只计一次，提交不同票不能覆盖；第二轮仅统计新票。
- 两场讨论都暂停同一 Agent；一场无建议或结束，不能释放另一场的暂停。
- 讨论 fork 读取消息不改变原 Agent 的未读状态；答询上下文不回流原会话。
- 迟到票补齐与用户提交同时发生，只有一个结果被正式接收；另一方得到明确过期反馈。
- 结果已保存但通知未写入时崩溃，重启补齐通知后才放行；不重复创建后续任务。
- 第一轮无建议恢复的 Agent 不加入第二轮；其后续普通 @ 不被旧讨论吞掉。
- 等待用户时重启，继续保留占位与暂停关系；恢复不能自动重放代码修改或外部操作。
- 无法确认暂停、来源会话不可恢复、投票进程退出分别可观测；不能统一记成无建议。

这些是后续实现的验证方向，尚未在本项目中编写或执行。

## 11. 阅读顺序与初筛记录

建议阅读顺序：**AO 的 Session 与反馈回流 → OMC 的投递/任务状态 → Mail 的收件人模型 → LangGraphJS 的恢复测试 → AutoGen 的暂停与 debate 样例**。SDK 实现接口始终回到官方文档与安装版本核查。

初筛还查看了 Ruflo、Overstory、ChatEval、Multi-Agents-Debate、quorum-cli 等仓库的公开元数据。其中 Overstory 在查询时已归档；其余未完成与上述六项同等深度的源码核验，因此不在本文宣称它们已经实现或缺少某项协议。此次结论是针对已检查样本，不是 GitHub 全量项目排名。
