# 按场景渐进加载群聊上下文

日期：2026-09-17。状态：用户已授权实现，首版已落地。采用按场景 session、原生 UserPromptSubmit 动态注入、近期原文窗口作为摘要降级、CLI 字面检索；详见 implementation.md 的同日实现记录。下文保留调研取舍，模型生成的缓存摘要和搜索索引仍为后续优化。

## 调研结论

推荐采用 **Agent 身份共享、每个会话场景独立 SDK session、共享有版本的私聊背景、Skill/CLI 按需读取原文**。

选择它的理由是用户同时提出“群私聊上下文解耦”和“其它群默认只显示目录”。单 session 可以解决 UI 串消息，也能减少首次注入，但已经读入的群正文会随 resume 进入之后的私聊；它无法仅靠来源标签恢复场景边界。每场景 session 能避免另一场景的完整执行史被自动继承，同时通过可检索的背景和原文保持同一个 Agent 的知识连续性。

这里的边界是工作上下文，不是信息保密：用户已允许 Agent 跨场景取材。私聊主动读取某群后，该片段可以留在私聊 session；群中读取其他群后同理。若要求每一轮连先前读取的跨群片段都不可存在，则本方案也不满足，需要另行设计每轮受控重建。

默认把“群中可使用自身私聊消息”实现为“必要背景首屏可见，完整原文可检索”，而非每次复制全部私聊。它保留信息可达性，但不能保证模型无检索就记住所有私聊细节。这是本次推荐的明确取舍。

## 用户已提出的方向

1. 私聊运行：自身私聊上下文＋所在群的摘要目录（群名、成员、消息数），不自动装入各群正文。
2. 群聊运行：可使用自身私聊消息，并提供当前群摘要和未读、被 @ 状态。
3. 群聊运行还展示其他所在群的目录；需要时自行通过 CLI 读取，支持检索。
4. 延续前一轮要求：群聊执行不向私聊 UI 新增聊天记录。

这将前一稿“群默认不读取私聊、跨会话只能明确授权引用”的建议改为“场景优先、可按需共享”。前一稿是候选，不是已确认限制。本轮没有要求完全信息保密隔离。

## 职责划分

- runtime：确定当前场景、目的地和 SDK session；在本轮输入中加入带版本的目录/当前群摘要。稳定角色指令留在 systemPrompt，动态状态不依赖恢复时修改 systemPrompt 生效。
- CLI/服务：返回目录、分页正文、搜索片段、上下文窗口；检查身份及群成员资格，计算未读和 @，限制结果大小，持久保存确认。
- Skill：教 Agent 何时查目录、先查哪个范围、何时读正文与确认。Skill 本身不保存动态群消息，也不负责上下文删改。
- SDK：继续负责原生 Skill 发现、Query 执行、工具结果历史、会话恢复和压缩。

复用应用现有插件加载机制，无需开启用户/项目 Claude 设置、引入 MCP 或安装 Codex 个人 Skill。

## 两种场景的初始材料

| 内容 | 私聊 | 群聊 R1 |
| --- | --- | --- |
| 当前用户输入或触发消息 | 完整提供并标明来源 | 完整提供并标明 R1 来源 |
| 自身私聊信息 | 恢复本私聊 session | 推荐：当前有效背景＋摘要未覆盖的近期增量；原文可检索 |
| R1 元信息 | 目录条目 | 当前群卡片：成员、消息数、未读/@、最新序号 |
| R1 内容摘要 | 默认不装入 | 有预算的内容摘要及覆盖范围 |
| 其他群 | 仅目录 | 仅目录 |
| 额外正文 | CLI 按需读取 | CLI 按需读取 |

不能只给“未读 5 条”却不给当前触发任务；当前用户请求是执行输入，完整保留。自动唤醒可只有状态卡，随后读 CLI。

建议首版目录为确定性元数据，不调用模型生成每个群的文字摘要；字段包括 roomId、名称、成员 ID/名字、messageCount、unreadCount、unreadMentionCount、latestSeq、roomVersion、asOf。unreadMentionCount 是 unreadCount 的子集，不与之相加。消息数只统计已提交且当前身份可见的群消息，不含工具活动、held draft 或私聊。

目录过长时按当前群、未读 @、未读、最近活动排序，限制条目/字符，返回隐藏数量及继续查询入口。目录属于某个时点的快照，不是实时不变事实。

当前群“元数据卡”和“内容摘要”分开。首版可用最近消息截断预览；若需要模型概括，摘要持久缓存并带 sourceMessageIds / coveredThroughSeq / generatedAt，新增部分明确标为未覆盖。摘要不是原始证据，不自动触发已读确认。

## CLI

以下目录、检查、列表、检索与展开接口已实现；另有 message get 分段读取长正文，详细参数见协作 Skill 的 references/context.md。

```bash
# 第一层：刷新所有已加入群的目录，不带正文
raftctl room list --json

# 第二层：当前群卡片与可选的内容摘要
raftctl room inspect --room R1 --json

# 第三层：分页读原文；两个过滤参数可同时使用
raftctl message list --room R1 --unread --mentioned --limit 20 --json
raftctl message list --room R1 --after-seq 120 --limit 20 --json

# 搜索：优先当前群，跨群必须显式指定 joined
raftctl message search --room R1 --query '接口 超时' --limit 10 --json
raftctl message search --scope joined --query '接口 超时' --limit 10 --json

# 根据检索结果展开命中附近的原文；邻近范围不越过所属群
raftctl message context --id M123 --before 3 --after 3 --json

# 沿用已有命令，确认实际完整读取的消息；重试复用 request-id
raftctl inbox ack --ids M123,M124 --request-id read-001 --json
```

读结果统一携带消息 ID、roomId、sender、seq、时间、@ 列表、未读状态、正文截断标志，以及 snapshotSeq / nextCursor。分页绑定查询条件和截止序号，避免新消息插入造成跳页。首版搜索按 seq 升序返回；未实现语义相关性排序。展开后的会话片段也按 seq 排列。

建议首版检索：中文可用的字面关键词匹配、发送者、时间范围、未读、@ 筛选；多个词的 AND/OR 语义需写进 help。先不增加向量库。当前 JSON 状态适合小规模扫描；数据增长后再评估独立索引及中文分词，不能直接假定 SQLite FTS 默认分词足够。

每条 snippet 限长，整次响应也有字符上限；搜索结果含总数/是否截断/后续游标。关键字无结果不等于该事实不存在。搜索仅覆盖自己当前有权查看的群；不能由模型传入任意 agentId 冒充身份。

## 已读与加载状态

三个概念分开：

1. Agent 的已读确认：`(agentId, messageId)`，沿用显式 ack；不表示任务完成。
2. 当前 session 的内容投递：`(sessionId, messageId, revision)`，区分 snippet、截断正文、完整正文；不能仅以“ack 过”判断本 session 已看过。它只证明曾投递，不证明压缩后模型仍持有全文，不能据此拒绝重新读取。
3. 摘要覆盖位置：表示摘要包含哪些消息，不替代前两者。

目录、检索及分页读取不自动清空未读。只看到 snippet 或截断内容时不批量确认全部命中。已确认消息仍可按 ID/关键词读取；默认未读队列不返回，不代表必须从历史删除。

重试和异常边界：CLI 返回成功不证明 SDK 已持久保存工具结果，不承诺恰好一次投递；保留消息 ID 和重复标记，继续用 requestId 保护写命令。

## Skill 候选形态

建议在应用资源中新增短小的 `raft-room-context` Skill，或在现有协作 Skill 中拆出对应参考文件，避免两个入口都要求先读取全量 inbox。

```text
resources/raft-plugin/skills/raft-room-context/
  SKILL.md                 场景判断、目录→搜索→正文、确认原则
  references/search.md     过滤器、检索和游标；仅复杂查询时加载
```

入口行为约定：

- 先处理当前场景的请求，当前群未读 @ 优先；普通消息按相关性读取。
- 私聊中不因为其他群有未读就自动遍历所有群，避免覆盖用户当前目标。
- 有明确线索时先限定当前群搜索，必要时跨已加入群检索；不为清零未读而读取全部历史。
- 跨群结果保留来源。读取其他群不改变当前 Run 的回复目的地；需要向另一个群发言时使用显式发送命令。
- 只有实际获取的内容才作为证据，不能把未读数量或摘要当成任务已经完成。

原有协作 Skill 第一条“先 inbox list”会主动加载跨群正文；本次已同步调整 Skill、runtime 唤醒和 PostToolBatch，inbox list 默认限定当前场景。

## Session 策略比较与推荐

“本轮只添加目录”不等于“恢复后的整个上下文只有目录”。SDK resume 会恢复之前的工具结果；CLI 曾读过的群正文仍可能保留，SDK 压缩也不能保证按场景忘掉。

- A：每 Agent 保留单个 SDK session。适合“保留已读记忆，仅控制新消息注入”；最小改造，但群私聊上下文仍会积累混合。
- B：每 Agent × 场景独立 session。runtime 注入私聊背景的受控投影，其他群正文按需读入当前 session。私聊信息更新要带版本/覆盖序号，不重复粘贴整段历史；信息一旦读入该 session 也不会自动遗忘。
- 若要求每轮输入完全可控，才考虑新 Query＋应用筛选重建；不作为当前首选。

调研后推荐 B，群携带有预算的私聊背景及必要增量，完整原文按需读取。用户随后已授权实现，本次选定 B；摘要先采用上述原文窗口降级方案。

| 选择 | 强项 | 代价 | 何时更合适 |
| --- | --- | --- | --- |
| A：单 Agent 单 session | 私聊和群频繁接力任务时，工作过程最连续；改动最少 | 已读正文、旧指令和工具结果混合积累，场景切换不清除 | 少量高度相关群，用户明确接受统一工作记忆 |
| B：Agent × 场景 session | 当前场景连续；其它场景通过背景/检索进入，范围较可解释 | 背景同步、跨场景接力需要来源引用 | 本项目当前的解耦与渐进加载需求 |
| C：每轮新建 session | 应用能更严格选择每轮材料 | 需重建续接资料，容易重复实现 SDK 的历史管理 | 有明确逐轮可见性要求的特殊任务 |

不能以 UI 不串消息单独推出必须拆 session：OpenClaw 支持群路由到主 session，同时保持回源群回复。也不能说 B 一定省 token：它减少无关历史，却可能重复加载共享材料。结论来自当前产品目标，不是框架的强制要求。

## 私聊背景与跨场景接力

共享背景先做成小型可追溯数据：`agentId / version / coveredThroughSeq / sourceMessageIds / generatedAt / text`。内容以目标、明确偏好、已确认决定、未完成承诺为主，不把 SDK 工具输出、失败重试和推测全部当作长期事实。指令保留适用范围，不能把“仅这个任务这样做”升级为全局偏好。

每轮 runtime 比较版本，注入当前有效背景或清晰标明替代关系的增量。缓存摘要落后时附未覆盖的私聊消息；超预算则显示缺口和读取入口，不能伪装成已完整同步。摘要更新可在源消息变化后进行，不为每个群的每次运行重新生成一份。首版摘要不可用时降级为带来源的近期原文窗口；不需要新建常驻记忆 Agent。

读取私聊原文也需明确接口，例如候选 `raftctl message search --scope private --query '部署约束' --json`，仅指当前身份自己的私聊；群/私聊搜索结果统一使用 message ID，再通过 `message context` 展开。跨群检索的 `--scope joined` 不隐式扩大到私人消息。

“私聊继续刚才群里的第三个方案”应按最近任务引用找到来源群、相关消息和运行产物，再展开必要片段。若存在多个同样合理的“刚才”，需要澄清，不能随机取最近一个群。跨场景任务接力优先传一个小型任务交接记录（目标、当前状态、产物路径、待办、来源 run/message IDs），避免搬运整个 SDK transcript。第一版可直接沿用已有任务记录及显式消息链接；不必先建设通用记忆系统。

## 场景与异常矩阵

| 场景 | 推荐行为 | 防止的错误 |
| --- | --- | --- |
| 私聊收到用户任务，群同时有消息 | 私聊完整任务＋群目录；群的待执行项进入各自队列 | 群消息抢占私聊目标或被当成当前用户授权 |
| 群内明确 @ 或直接请求 | 预装触发消息原文、当前群卡片、必要上下文；其余按需读 | 为理解当前问题先连续调用多次 CLI |
| 普通群消息触发唤醒 | 保留现有唤醒语义；按该群入队，读取是否相关后可沉默 | 擅自把所有普通消息改为永不处理 |
| 多群同时唤醒 | 同一 Agent 按场景串行；@ 可提高优先级，等待时间防止普通消息饿死 | 多群合并后回落私聊，或反复唤醒同一未读项 |
| A 群中搜索 B 群 | 加载 B 群的有来源片段，Run 仍属于 A 群 | 检索改变回复目的地 |
| 私聊更新要求，群 session 已存在 | 下一轮按版本同步；运行中在现有安全检查点提示关键变化 | 旧背景长期覆盖新要求；承诺即时跨进程同步 |
| 摘要只到 seq=120，新消息到 130 | 标注覆盖 120，读取必要的 121–130；触发消息无论是否覆盖都明确提供 | 把过期摘要当最新结论 |
| 消息已在另一场景 ack | 本场景仍可按 ID/时间范围读取；“没有未读”不等于“本场景已知” | 用 Agent 级已读当作 session 级上下文 |
| SDK 已 compact | 摘要和曾投递记录仅作线索，必要时重新读取原文 | 将已加载表当成模型真实内存 |
| 新成员加入群 | 历史可见数与入群后收到的未读分开；延续当前不回填 receipt 的行为 | 未读数突然等于全部群历史 |
| 同群有多个 Agent | 共享群消息，各 Agent 独立 session/receipt | 多个 Agent 共用一份模型历史 |
| 群任务委派子 Agent | 结果回 origin conversation，作为父 Agent 的执行输入；公开仍走 room send | 子任务结果写入父私聊，或未经整理自动广播 |
| 服务崩溃或发送后超时 | 恢复持久状态；未知 Run 保持未知，查询已有 request-id 结果再决定重试 | 重复发群消息、重复执行有副作用操作 |
| 将来退群/撤销读取权限 | 服务拒绝后续读取；已进入 session 的材料无法靠退群自动抹除 | 把权限撤回等同于模型遗忘 |
| 成百上千个群/大量消息 | 目录和正文分别限额并分页，优先当前场景与 @；需要时才建索引 | 目录本身撑满上下文 |

同一 Agent 首版仍只运行一轮，并不因拆 session 就允许并行修改同一工作目录。用户停止 Agent 时停止当前运行；会话映射、群消息、确认状态继续保留。其它 Agent 的共享文件写入冲突仍是独立问题。

## SDK 复用与应用扩展边界

已核对锁定安装版本 `@anthropic-ai/claude-agent-sdk@0.3.267` 的本地类型及官方文档：

- 使用明确的 `resume: sdkSessionId`，继续由 SDK 处理历史、工具循环和自动压缩。不依赖同 cwd 的 `continue:true` 选最近会话，也不用 fork 从混合历史创建场景。
- 稳定角色放 systemPrompt；本轮场景、目的地说明、群目录、背景版本放 prompt。默认 system prompt snapshot 的实际启用依赖 CLI/提供方环境，resume 修改 append 并非可靠动态输入通道。
- Skill 负责渐进暴露操作说明，动态数据由 CLI 返回；继续使用应用已有 local plugin 加载方式，不接 MCP。
- 若工具结果还需裁剪，0.3.267 提供 `PostToolUse.updatedToolOutput`；首版优先 CLI 自身限制返回量，不额外叠加裁剪器。替换输出不能删除已经进入历史的正文。
- 同 cwd 的独立 session 仍共享文件，SDK auto-memory 也可能使用同一默认目录。实现时建议显式关闭 auto-memory，由应用提供上述共享背景，避免额外的隐式记忆通道；不把 session 分区描述为文件或权限沙箱。当前 YOLO 与 Bash 沙箱配置是独立维度。

SDK 没有已核实的本项目业务对象：群成员、群未读/@、消息搜索、会话到 UI 的路由、私聊背景发布版本。自定义范围仅覆盖这些业务数据与集成，不接管模型的整份 transcript。

## 实现范围与顺序建议

1. **固定会话和输出归属**：建立 `(agentId, conversationId) → sdkSessionId`；Input/Run/trace/委派返回携带 conversationId 与 replyTarget。按场景维护调度通知位置，替换现在 Agent 全局 notices 的消费方式，避免处理一个群就吞掉其它群唤醒。
2. **接入上下文材料和读取 CLI**：每轮场景快照、当前输入、背景版本、目录；实现 inspect/list/search/context 和私聊原文读取。消息增加持久递增 seq；不能把当前只有 Receipt.arrival 的事件序号直接冒充所有消息都有 seq。读取路径只读，尽量不走全量状态 clone/写事务。
3. **调整 Skill 与 hooks**：移除无条件全局 inbox 正文读取，明确当前范围、检索扩大条件和 ack 规则。文档里的候选 CLI 可用后再发布对应 Skill。
4. **补摘要与规模优化**：先有原文窗口和来源引用，再加缓存摘要。根据真实耗时、漏检和输入量决定是否增加索引/分词，不先上向量库。

推荐继续保留 `room send` 为唯一公开群消息的入口，沿用 basedOn/version、held draft 与 request-id 语义。群执行的普通模型文字进入该场景的执行详情；不要把每个 assistant 文本块都当公开群发言，也不要同时自动发布 final 和显式 send 导致重复。私聊 UI 只接私聊消息；history/trace API 也必须按场景筛选。

旧混合 SDK session 不应 fork 到每个新场景。保留为历史归档，新场景用干净 session 加必要的来源明确材料启动；无法可靠判断旧消息归属时标明旧记录，不猜测迁移。只迁移必要状态，不删除旧历史来伪装隔离。

## 调研证据与后续验证

本轮做了只读代码/文档核验和内存 SQLite 检索探针，没有调用付费模型，也没有执行新架构。Node 内存库中插入“登录接口发生超时，需要重试”：`unicode61 MATCH '超时'` 与 `trigram MATCH '超时'` 都无命中，字面 `instr` 命中；`trigram MATCH '发生超时'` 命中。这只是小型可复现实验，说明不能把默认 FTS 或 trigram 当作短中文关键词检索的完整方案，不是性能结论。

首版建议定义多关键词为 AND、提供显式 OR；先用字面匹配与结构化过滤。需要验证中文双字词、英文缩写、代码符号、否定表达和同义词漏检；未检索到不能解释为信息不存在。全文扫描的可接受规模要用实际数据测量。

实现后除下文验收项外，应对同一组场景比较 A/B：任务成功与来源正确性、错目的地发布次数、遗漏 @、工具往返次数、输入 token/缓存 token、首答延迟。使用相同模型与消息集合；低消息量/高度相关群和高消息量/独立项目分别测试，不能用单个例子声称准确率或费用提升。

先用假 runner 验证路由、游标、队列和 ack；再做当前 SDK/提供方的最小集成验证：两个 scene 交替 resume、Skill 发现、snapshot 行为、工具结果保留、compact 后重读与 auto-memory 设置。配置和本地类型支持不等于端到端行为已验证。

一手资料及其适用边界：

- [Claude Agent SDK Sessions](https://code.claude.com/docs/en/agent-sdk/sessions)：resume/fork 的历史语义；支持会话复用，不提供应用群目录。
- [修改 system prompt](https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts#change-the-prompt-of-an-existing-session)：动态输入与 snapshot 限制。
- [Skills](https://code.claude.com/docs/en/agent-sdk/skills)、[Hooks](https://code.claude.com/docs/en/agent-sdk/hooks)、[Agent loop](https://code.claude.com/docs/en/agent-sdk/agent-loop)：原生渐进发现、结果处理和压缩。
- [Anthropic Context Engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)：轻量引用和运行时读取，以及必要材料预加载与自主探索结合；不主张所有信息都先隐藏。
- [OpenClaw Sessions](https://docs.openclaw.ai/concepts/session)、[Main session](https://docs.openclaw.ai/concepts/main-session)：默认按群分 session，也允许 groupScope=main；上下文选择与回复来源路由独立。其默认私人记忆共享边界不同于本用户需求，不能直接照搬。
- [LangGraph Memory](https://docs.langchain.com/oss/python/langgraph/memory)：thread 级历史与跨 thread 记忆分层；作为架构参照，不引入该依赖。

## 输出、调度与验收

每个 Run 必须有固定 sourceConversationId 和 replyTarget。多个群的唤醒可以合并目录提醒，但不能用“多群→私聊”代替明确的执行目的地。群输出不写私聊，中间文本只保留执行记录；子任务结果回发起场景，跨群读取也不改返回位置。

第一版继续每 Agent 同时一轮；上下文按需加载与任务并发是不同问题。

后续实现验收：初始上下文无其他群正文；目录数值准确；中文检索可用；分页不重不漏；@ 已读状态准确；搜索不自动 ack；越权群读取失败；跨群取材不改变输出目的地；群聊不更新私聊；停止/重启保留消息与确认状态；resume 后已读正文是否保留符合所选 A/B 语义。

依据：[SDK Skills](https://code.claude.com/docs/en/agent-sdk/skills)、[SDK Sessions](https://code.claude.com/docs/en/agent-sdk/sessions)、本地 0.3.267 类型及现有 runtime/store/control/协作 Skill。首版测试结果见 implementation.md，研究阶段与实现阶段证据分开记录。
