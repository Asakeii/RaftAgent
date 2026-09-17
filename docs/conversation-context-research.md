# 群聊与私聊上下文解耦：调研与候选设计

日期：2026-09-16。状态：调研稿，尚未选定最终产品语义，未修改运行逻辑。

2026-09-17：用户提出“场景优先＋群目录＋CLI 渐进加载”的新方向，群聊允许使用自身私聊信息。后续调研推荐“按场景独立 session＋有版本的私聊背景＋原文按需检索”，并记录单 session 更适合的条件，见 [渐进加载调研与推荐设计](progressive-room-context-design.md)。用户随后已授权实现，首版已落地；历史比较以新设计及 implementation.md 的实现范围为准。本文下方的隔离优先建议保留为历史比较，不作为已确认约束。

用户明确要求：群聊中与 Agent 对话，不应更新该 Agent 的私聊聊天记录。用户同时提出上下文解耦，并希望比较 runtime 组装上下文与按时间线标记来源。尚待确认：跨会话共享是否默认允许、是否只允许明确引用、群聊输出的发布规则。

## 1. 先拆开四个对象

- AgentIdentity：是谁；名字、职责、工具策略、预算和工作目录。
- Conversation：在哪里交流；私聊、群聊或未来群内话题。
- AgentSession：该身份在该会话范围中的 SDK 上下文。
- Run：一次执行；绑定会话、输入、SDK session、输出目的地和工具权限。

UI 时间线是公开消息的投影；SDK transcript 还含工具输入/结果、中间响应和注入材料。两者不能直接等同。是否在 UI 显示与是否被模型读取，是两个独立选择。

## 2. 当前代码事实

| 位置 | 实际行为 | 影响 |
| --- | --- | --- |
| `src/contracts.ts` 的 Agent | 只有一个 sessionId | 私聊与各群没有独立 SDK 会话映射 |
| `src/runtime.ts` 的 run | 每次 resume agent.sessionId | 群消息读进会话后，后续私聊继续携带这些内容 |
| `src/runtime.ts` 的 assistant 分支 | 所有文本写入 channel=agent.id | 群触发的模型文字也进入私聊 |
| `src/runtime.ts` 的 tick | 跨房间收件提醒合并成一轮；多房间时 channel 回落为 agent.id | 一个 Run 可能混合多个来源，不能简单地把输出改成 input.channel |
| PostToolBatch Hook | 检查该 Agent 全部 receipts | 私聊运行也会被群消息提醒并可能读取正文 |
| `src/store.ts` 的 inbox.list/ack | 默认跨该 Agent 所有房间；只校验 Agent 身份 | 拆 session 后仍可能通过工具重新混入其他会话 |
| delegate/delegationResult | 结果定位父 Agent，写父 Agent 私聊并投 inbox | 群聊发起的子任务会把结果回流到父私聊 |
| `src/server.ts` 的 history 接口 | 按 Agent 汇集 sessionId 和 trace 关联会话 | 新设计还需把会话详情按 Conversation 筛选 |

旧 `desktop-assistant-architecture.md` 明确使用“每身份一个工作会话”的候选架构；本次方案若选定，需要更新旧设计，但本调研不直接覆写其已确认决策。保留 SDK、本地工具→CLI→服务和显式收件确认约定。

## 3. 官方 SDK 能力核验

核验本地安装的 `@anthropic-ai/claude-agent-sdk@0.3.267` 类型声明与在线官方文档。

1. `query` 新建会话；`resume: sessionId` 恢复指定会话的历史，包括已进入历史的工具调用和结果。
2. `continue: true` 找当前目录最近会话；同一工作目录管理多会话时应使用明确的 resume ID，避免选错。
3. `forkSession` 复制原会话历史。它适合探索分支，不适合从含私聊信息的 session 创建“干净群聊”。分叉不清除既有私聊内容。
4. `persistSession: false` 控制是否落盘，不提供消息级权限筛选，也不会自动把混合历史拆开。
5. SDK 负责会话恢复、工具调用链和自动压缩。runtime 可以负责选择会话、组装本轮输入与经允许的引用，不必重新管理完整模型历史。
6. `getSessionMessages` 可用于历史读取；不能把“读取再过滤 UI 记录”误认为已过滤 resume 将加载的上下文。
7. 系统提示词存在 snapshot 行为：0.3.267 类型说明及官方文档均指出，在该行为生效的环境中，resume 可能继续使用已记录提示词，直到压缩。当前将动态 channel/kind 写入 systemPrompt 的做法不能作为可靠路由边界；是否在当前供应商启用仍需运行核验。建议稳定职责留在 systemPrompt，当前来源、消息范围、游标和引用清单放入本轮输入，授权由宿主执行。

本次没有验证或声称 SDK 提供“按业务频道删除已有 transcript 部分历史”的安全隔离 API。重排手工历史也不能自动保留工具调用链语义。

## 4. 三种方案比较

| 方案 | 模型看到的历史 | UI 可分开 | 上下文隔离 | 成本与适用情况 |
| --- | --- | --- | --- | --- |
| A：单 session，全部消息标来源并按序追加 | 私聊与群聊都在同一历史 | 可以 | 不隔离 | 改动较小，适合用户明确希望“一个统一记忆的助手” |
| B：每次新 Query，runtime 筛选并重建历史 | 由应用每轮挑选的材料 | 可以 | 取决于筛选与工具权限 | 历史去重、压缩、摘要、工具配对及缓存前缀都更复杂，不建议首版承担 |
| C：Agent × Conversation 独立 session，runtime 只增量组装输入 | 当前范围历史＋本轮消息＋允许的引用 | 可以 | 具备上下文分区，工具读取还需限制 | 最符合“上下文解耦”，复用 SDK 原生恢复与压缩；代价是跨会话连续性需要显式共享 |

建议以 C 为候选基线。A 并非错误，但应明确叫“分频道展示、共享上下文”，不能承诺群私聊上下文隔离。时间线标记与 runtime 组装可以同时用于 C：先按会话和权限筛选，再在所选范围内排序，而非先把全局历史混成一条。

## 5. 候选模型和数据链路

```text
Agent A
  ├─ 私聊 D          → session(A,D)
  ├─ 群聊 R1         → session(A,R1)
  └─ 群聊 R2         → session(A,R2)
Agent B
  └─ 群聊 R1         → session(B,R1)
```

群 R1 的公开消息共享，但 A、B 各自保留独立推理和工具历史。不要让所有群成员共用一个 SDK session。

建议持久对象（概念字段，非最终 schema）：

```ts
Conversation { id, kind: 'direct' | 'room', members }
AgentSession { id, agentId, conversationId, sdkSessionId?, generation }
Message { id, conversationId, seq, sender, originRunId?, replyToMessageId?, text }
Input { id, agentSessionId, messageIds, status }
Run { id, agentSessionId, inputId, sdkSessionId?, replyTarget, status }
Delivery { messageId, agentSessionId, deliveredAt?, acknowledgedAt? }
Delegation { id, childAgentId, childSessionId, returnSessionId, originRunId }
ContextReference { id, sourceConversationId, sourceMessageIds, targetConversationId, version }
```

`seq` 是宿主分配的稳定顺序；时间戳用于展示，replyTo 用于因果关系。到达时间不能决定权限或说明哪个指令优先。

一轮群聊执行：

1. 用户在 R1 发消息，宿主写 Message，并为应接收成员创建 scoped delivery。
2. 调度器挑选 `(A,R1)` 的待处理输入，确定本轮截止 seq；不混入 D 或 R2 的未读。
3. 用 `AgentSession(A,R1).sdkSessionId` 恢复 SDK；首次运行则新建干净会话。
4. runtime 组装本轮材料：来源信封、该范围的新消息、当前任务状态、经允许的引用。已有 SDK 历史不整段重复拼接。
5. 固定来源信封由宿主生成，引用正文作为数据；其他 Agent 文本不提升成用户或系统指令。
6. 工具身份包含当前 agentSessionId/conversationId。inbox list/ack、room changes、任务读取与跨群发送都检查该范围，不能只靠提示词约束。
7. 新到 R2 消息排队等 R2 的 Run；不会通过 A 在 R1 的 PostToolBatch 混入。相同范围新到消息仍可沿用现有轻量提示＋按需读取。
8. 输出交给明确的发布路径；公开群消息只进 R1，内部执行内容归本次 Run。D 不新增消息、未读或会话摘要。
9. 保存新 session ID、执行状态和输入投递证据。传给模型、读取确认、任务完成保持不同状态；崩溃未知不盲目重投外部操作。

runtime 的“拼接”建议限制为：

```text
稳定 systemPrompt（身份职责与应用规则）
＋ SDK 恢复的当前范围历史
＋ 本轮输入（来源、消息 ID/序号、当前请求、允许的参考）
＋ 本范围工具按需读取的材料
```

如恢复后重新投递消息，需用消息 ID 追踪是否已经进入 SDK，不能用用户已读或“上次提醒过”直接替代投递确认。消息的读取与处理仍可能需要重试，业务写入继续使用 requestId 幂等。

## 6. 群聊输出发布：必须单独决定

当前只有 `raftctl room send` 正式发布群消息，SDK assistant 文本却被作为私聊消息保存。

- 候选 C1（改动较少，建议首版）：群聊 Run 的 SDK 文本只进执行日志/会话详情；群聊公开发言继续经 room send，保留 basedOn/held draft。系统提示明确要回复时使用该命令，未发言就是不新增群消息。
- 候选 C2（更像自然聊天）：本轮最终回复自动发布到来源群，同时复用版本检查、held draft 和幂等。需定义沉默结果以及避免同一内容又经 room send 发布。不能简单将所有 assistant 中间文本搬到群聊。

两者都能保证“群聊不更新私聊”。不要把显示修复与修改发言协议混为同一项。

## 7. 跨会话共享及边界

是否跨会话共享应由产品定义，不从 Agent 相同这一事实自动推出。

- 隔离优先：群会话默认不载入私聊；用户把选中消息/摘要明确分享至群后才可见。引用保留来源、版本、范围，不仅是一段无出处摘要。
- 连续性优先：私聊主会话可以接收群活动摘要或按需召回群历史；群侧仍不能默认获取私聊。单向共享与双向共享是不同选择。
- 共享项目规范/任务事实：可作为应用级或项目级材料显式加入多个范围；不要把“所有私聊摘要”当成默认共享记忆。
- 同工作目录、已发布 Skill、长期记忆文件和工具读文件仍可能造成信息交叉。SDK session 拆分提供上下文路由隔离，不等于 OS 保密隔离；当前 YOLO 和 Bash 默认读范围也不提供后者。若要求严格私密，需单独约束文件工具和共享记忆。
- 摘要也会携带敏感事实。共享权限被撤销后，只停止未来读取无法抹去旧 session 已经吸收的内容；强撤回需开始新会话代次，并仅从允许材料重建。

## 8. 调度、子任务与迁移

拆 session 不要求立即增加并发。第一阶段继续保留“每个 Agent 同时一轮、全局最多三轮”；只是从该 Agent 的多个会话队列挑选输入。这样不会因群私聊拆分突然让同一个工作目录被两个实例同时写入。公平性、私聊优先级和停止粒度后续可单独设计。

子任务必须记录 returnSessionId。群中委派完成后回到父 Agent 的原群会话收件箱，不能仅凭 parentAgentId 回到父私聊。通知不等于公开群消息，仍经过选定发布规则。

旧会话已混合，继续 resume 不会恢复隔离。建议：保留旧 SDK 历史为只读“历史混合会话”，从切换点为各范围创建新 session。可确定归属的公开消息继续保留原 UI 范围；SDK 中间文本缺少来源证据时不强行分类。即使能按 Run 标记重画 UI，也不能证明混合 SDK 历史已被清洗。

不要从旧混合 session fork 所有新范围，否则会把原来的混合上下文复制过去。允许显式选择旧材料引用到新范围，但需承认其共享语义。

## 9. 验收建议

1. 群中 @ A 后，A 私聊消息数、未读、最后消息预览不变。
2. 私聊 D、群 R1、群 R2 对应 A 的三个不同 SDK session；B 在 R1 还有自己的 session。
3. 用本地模型协议探针检查请求输入，不含其他范围独有标记；测试 resume 和压缩后路径。只看模型“没说出标记”不足以证明隔离。
4. 私聊运行遇到群消息，只排群队列；群运行读取 inbox、ack 或 history 时不能越过范围。
5. 群里发起子任务，完成通知回原范围，私聊不新增子任务结果。
6. 群消息连续到达仍合并处理；切范围不丢消息、不重复发布，正常重启/未知运行恢复不混用 session。
7. room send 与自动最终回复（如采用）不双发；held draft 不绕过版本检查。
8. 明确引用时传入允许材料；无授权时不自动载入跨范围摘要。
9. 历史混合会话留存可查，但不会作为新隔离会话的 resume/fork 来源。

## 10. 对照资料与证据范围

- [Claude Agent SDK Sessions](https://code.claude.com/docs/en/agent-sdk/sessions)：新建、指定 resume、fork 复制历史、会话与文件系统边界。
- [SDK TypeScript Reference](https://code.claude.com/docs/en/agent-sdk/typescript)：本地 0.3.267 的 query/resume/forkSession/persistSession/getSessionMessages 类型同步核对。
- [Modify system prompts](https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts#change-the-prompt-of-an-existing-session)：snapshot 与恢复时提示词更新行为；版本和启用环境有差异，不作当前供应商运行结论。
- [OpenClaw Session management](https://docs.openclaw.ai/concepts/session)：按来源选择 session key；群默认 per-group，可配置合入 main；session 路由与回复目的地分别控制。
- [OpenClaw Main session](https://docs.openclaw.ai/concepts/main-session)：群虽然默认独立，但主会话可接收活动通知和跨会话召回。因此不能把它的“独立群 session”误读成默认完全信息隔离。
- [OpenClaw Multi-agent routing](https://docs.openclaw.ai/concepts/multi-agent)：身份拥有多个会话，workspace 不是天然文件沙箱。

OpenClaw 仅作官方产品文档层面的对照，本次未审计其源码或做运行验证。SDK 部分是官方说明和安装类型核验；本项目部分是当前源码静态检查。本次未修改应用代码，也未运行模型验证新架构。
