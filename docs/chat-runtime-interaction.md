# 消息驱动与流式回复

当前群正文发布/沉默规则已由 [群聊正文默认发布与静默结束](group-default-replies.md) 更新；下文冲突描述保留为历史记录。

群 inbox 与群发送规则已由 [共享群 inbox](shared-group-inbox.md) 更新；以下关于普通群回答不触发成员的描述为上一版行为。

2026-09-17 根据新的交互要求调整，取代旧设计中“用户停止后必须点击继续”和“群普通回答只留执行详情”的规则。

## 用户行为

- 用户私聊直接唤醒目标 Agent；用户发群消息唤醒群成员，保持原有消息投递与 @ 优先级规则。
- 新消息恢复 stopped/error 状态，重置连续运行计数；不重放 unknown 输入。重启保留原历史，首次新消息即可工作。
- 移除成员列表的停止/继续按钮。当前会话有运行时，输入框发送箭头变成停止方块。运行中可以编辑草稿，Enter 不发送也不中断。
- 群停止会中断本群正在运行的成员，并取消本群尚未开始的待办。其它会话的执行不受该按钮影响。消息历史保留，新消息可再次唤醒。
- 停止命令带当前会话和界面观察到的 run IDs；重复旧请求不能停止新一轮。取消不可撤销已完成的文件或外部操作。
- 每个正在回复的成员显示头像、姓名和三点动画。加载状态按 run.channel 过滤，不因 Agent 在另一个窗口运行而误显示。

## SDK 核查

实际安装 `@anthropic-ai/claude-agent-sdk` 0.3.267。

- https://platform.claude.com/docs/en/agent-sdk/streaming-output
- https://platform.claude.com/docs/en/agent-sdk/typescript

复用 `includePartialMessages: true`、`stream_event` 的 `message_start`、`content_block_start`、`text_delta` 与已有的 `Query.interrupt()` / AbortController。官方说明：完整 assistant 按内容块发出，并可能早于 `content_block_stop`；同一 API message id 可以对应多个内容块。故按 run + API message id + block index 组织增量，并使用完整 assistant 校正/提交对应块，避免重复追加。

## 展示与持久化边界

`ReplyStream` 仅为展示适配器，SDK 仍管理执行循环与工具。文字增量在宿主内存中累积，SSE 通知前端读取快照（前端最多约每 80ms 合并刷新）；完整文本块入库，避免每个 token 重写数据库。刷新页面能从当前宿主快照恢复正在输出的文字。停止或错误时保存已显示的未完成文本并标记中断状态；进程强制崩溃前未完成的内存增量不保证持久化。

只展示 text，忽略 thinking、工具 JSON、SDK 子代理帧；群内内部委派输出继续仅回传委派者，不公开展示。

普通群回答写入当前群历史、推进房间版本，不写私聊；不会额外为所有成员创建触发回执，避免自动回答造成相互唤醒。需要发起新的协作时继续使用显式 `room send`，保留原有版本检查与草稿规则。系统提示词、场景上下文和协作 Skill 已同步说明，避免模型对同一回答再发送一次。

## 验证

使用隔离服务与模拟 SDK 事件验证：自动唤醒、停止收尾竞态、重复停止请求、多成员群聊、排队取消与其它会话隔离；多内容块流式合并、完整事件去重、工具/思考过滤、中断保留。浏览器验证加载动画、发送/停止切换、刷新恢复、草稿保留和再次发送。无真实模型调用。
