# 群消息撤回与真实交接

2026-09-18：群消息提供用户撤回按钮和 Agent 本地命令。

```
raftctl room retract --id MESSAGE_ID --reason '正文不完整，重新整理' --request-id UNIQUE_ID
```

用户可撤回当前群的公开消息；Agent 只能撤回当前运行所在群中自己发出的消息。命令幂等，保留消息 ID 和撤回标记，正文替换为“消息已撤回”，清空原 mentions。追加独立的撤回通知并推进群版本，使已经消费过原消息的其他成员也能获知原内容失效；界面只显示原位置的撤回标记。撤回后不再把该回复或撤回通知计入本人已回应状态，允许重新回答。

撤回不是安全擦除：历史 SDK 会话、Trace 和已经执行的外部动作不会回滚。新查询不再提供原正文，运行中的成员通过新增通知获知失效；无法保证已读过消息的模型遗忘原内容。这里不改写历史日志。

Stop Hook 可能早于宿主接收完整 assistant 文本块。群发布现在等待已开始文本块完成，最多 5 秒；超时返回原生 Stop block，禁止用 close(false) 提前封口半截增量。异常和停止仍丢弃未公开群片段。模型已经返回成功但内容语义上不完整时，不用句号或长度猜测错误；用户或 Agent 可显式撤回。

群内交接现有成员时，实际调用 room send，传 --mentions 目标 ID，正文直接布置任务并要求在本群回应。不得只有“我会让某人做”的承诺。界面依据结构化 mentions 显示 @ 标签，普通文本中的名字不伪装成已交接。

SDK 依据：[Streaming output](https://platform.claude.com/docs/en/agent-sdk/streaming-output)、[Hooks](https://platform.claude.com/docs/en/agent-sdk/hooks)，核对安装 TypeScript SDK 0.3.267。复用 SDK assistant/stream_event 与原生 Stop Hook；撤回及群 mentions 是应用业务状态，沿用 Bash → CLI → Store，不另造模型循环。

验证：撤回权限、重复请求、重启持久化、本人回应状态恢复、通知与查询、Stop/完整正文到达顺序；浏览器验证撤回后隐藏正文及刷新状态；真实模型隔离测试为 tests/group-handoff-live-smoke.ts。

2026-09-18 验证结果：94 项自动化测试、类型检查和构建通过；真实 SDK 的 inbox/Stop/草稿链路通过；浏览器撤回与刷新通过；doubao-seed-2-0-mini-260428 隔离交接测试中，协调成员发送带 mentions 的公开任务消息，邮箱成员在本群回复虚构面试时间。单次模型验证不等同于任意措辞都能正确交接。
