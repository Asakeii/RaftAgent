# 群聊正文默认发布与草稿检查

2026-09-18：本文件描述当前实现，取代早期的普通群正文实时发布、单协调筛选和定向唤醒规则。每成员列表见 [per-agent-inbox.md](per-agent-inbox.md)。

## 数据链路

1. 公开消息共用一份历史，每个成员维护独立消费位置。消息的来源分为用户请求、成员更新和内部委派结果；空闲成员被拉起时接收预览与请求处理状态，按需用 `view_inbox --ids ID,ID` 展开正文。运行中的新 @ 通过原生 Hooks 提醒。
2. 每条用户消息的 ID 是独立请求 ID；相同文字的新用户消息仍是新请求。运行与公开回复保存 replyToRequestId；成员更新继承原请求。本人是否已经回答从持久化公开回复派生，和 inbox 是否已消费分开。旧消息只回溯同群此前用户消息，不关联未来请求。
3. 群运行普通正文暂存在宿主中，不进入公开 streamingMessages。Stop Hook 关闭当前文本块并合并本轮正文，检查生成时观察的群版本和本人是否已经回答该请求。
4. 检查通过后自动发布，无需 room send。版本变化或已回应则保存 held 草稿，返回变化摘要、本人此前回复和操作选项；SDK 原生 Stop `decision: block` 让同一个 query 继续处理。
5. Agent 选择 retry、revise、discard 或 force。retry/revise 继续检查最新版本；已回应同一请求时必须通过 `--contribution` 说明新增价值，force 也不能绕过这个要求。force 仅显式跳过版本检查，不会自动执行。
6. 无需回复调用 `raftctl room silence --request-id UNIQUE_ID`。该运行的 held 草稿被丢弃，PostToolUse/PostToolBatch 返回 continue:false，后续正文不发布。已经公开的消息不会撤回。

## 运行与边界

- 只要本轮还有未处理的 held 草稿，Stop 就以 decision:block 返回同一 SDK 循环；即使 Agent 没再输出正文，也会收到最新 inbox。移除旧的三次反馈上限，执行资源仍由 SDK 原生 maxTurns/maxBudgetUsd 和用户停止控制；达到运行限制不自动发布草稿。
- 私聊保留流式展示和停止后的部分正文；群停止丢弃未公开的文本片段。内部委派只回传委派者。
- 显式 room send 与普通正文走相同发布检查；跨群显式发送不继承当前群的请求 ID。发送成功后不要输出重复确认。
- view_inbox 无 ids 时消费自己的新增批次；只有消费完列表才更新运行观察版本。按 ID 展开不消费列表、不宣称已经观察最新群版本。长正文仍遵循 6000 字单条上限，按 nextOffset 继续读取。
- 批次可能含多个请求，运行的默认关联优先取批次中最新的用户请求；只有成员更新时取最后一个可关联请求，避免旧请求的迟到回复覆盖新请求。每条预览仍各自包含请求状态。这不是细粒度任务完成账本。
- contribution 是可审计的声明，不是语义去重分类器；模型仍可能声明无价值的补充。此实现防止无判断重复发布，不保证模型判断总是正确。
- 普通成员更新仍可唤醒其它成员检查，但不是新的用户授权，也不要求每人再次回应。

## SDK 与参考来源

已核对锁定的 TypeScript SDK `@anthropic-ai/claude-agent-sdk@0.3.267`，使用原生 query、includePartialMessages、Stop、PreToolUse、PostToolUse 和 PostToolBatch；不重写 SDK 循环，不新增 MCP。

- [官方 Hooks](https://platform.claude.com/docs/en/agent-sdk/hooks)
- [官方 TypeScript API](https://platform.claude.com/docs/en/agent-sdk/typescript)
- [Raft 群协作文章](https://raft.build/resources/blog/is-having-agents-in-the-room-meant-to-be-chaotic/)

文章启发了按需读取和可修订的 held 草稿；请求关联与重复回应检查是本项目的业务扩展。SDK 不维护 Raft 的群历史、成员消费位置和公开发送事务，因此这些状态由 Store 管理，模型循环仍交给 SDK。

2026-09-18 冲突回送优化：重新核对官方 Hooks 与 SDK 0.3.267 的 Stop decision/block。held 反馈内附最新 sharedInbox（20 条分页、单条 2000 字，nextCursor/nextOffset 可继续读取）、原请求本人回应状态、草稿正文与正确的 --id 操作命令。读取反馈不消费 inbox、不自动重发。版本变化本身不是静默或重复的判定依据；用户要求每人回应时，其他人的招呼不能替代本人首次回应。

## 验证

`npm run check` 覆盖类型、回归和构建。新增测试覆盖同请求重复回应、多人独立回答、新请求、再次版本冲突、明确贡献后修订、静默丢弃、选择读取与跨群隔离。

`npx tsx tests/inbox-sdk-smoke.ts` 使用本地脚本供应商与真实 SDK/Bash/CLI/socket，检查工具前 @ 提醒、Stop 继续、冲突草稿重试及重复正文静默丢弃；不调用付费模型。浏览器回归为 `npx tsx tests/chat-streaming-smoke.ts`。

冲突回送回归：`npx tsx tests/group-version-live-smoke.ts` 使用当前配置的真实模型，仅创建隔离数据和虚构群聊，验证“各位打个招呼”四成员各回复一次，且至少一个版本冲突草稿经重新判断后 committed。2026-09-18 使用 doubao-seed-2-0-mini-260428 单次通过；证据保存在 `.raft/verification/group-version-live.json`。这是一次真实行为验证，不代表所有模型与复杂场景均已覆盖。
