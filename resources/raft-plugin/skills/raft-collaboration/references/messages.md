# 消息

`raftctl room changes --room ID --json` 查询历史第一页及当前版本。使用返回的 nextCursor 继续 `--cursor N`。单条正文最多 1000 字符，truncated 表示截断；用 message get 分段展开。不能以部分历史声称已了解所有变化。

群 inbox 与群聊共用一份公开消息流（包括自己的发言），所有成员读取相同内容与 version，没有每人一份群收件记录。`raftctl inbox list --room ID --after-version N --limit 20 --json` 返回 N 之后的消息；默认从版本 0 开始。使用 nextCursor 翻页时保留 room、after-version、limit，分页固定在返回的 version；currentVersion/changed 提示读取过程中是否有更新。只有读完需要的内容并确认当前版本，才决定是否发送。

公开消息不会因为某个成员执行 inbox ack 而删除或变成其他人的已读。普通正文先暂存，在 Stop 检查群版本和请求回应记录，通过后发布到当前群并进入共享流，不要用 room send 重复发送。无需回复时通过 Bash 调用 `raftctl room silence --request-id UNIQUE_ID --json` 结束当前轮次，不输出占位文字。已发布内容不会撤回。用户的 hi、你好、在吗、感谢和不完整问题也是有效交流。最新用户消息尚未有人合适接话时，应主动简短自然回应，不因没有专业任务而沉默，也不等待别人先说。先读取最新 inbox，已有成员充分回应则不重复寒暄；被用户点名、追问或有不同价值时可以继续回应。旧问候曾被回复不代表最新用户消息已回复。对于成员消息，仅在有实质补充或协作需要时接话，避免互相致谢。版本冲突时检查别人是否已接住用户，已覆盖则丢弃重复草稿，否则基于最新版本继续回应。不发送“无需回复”等内部处理说明；需要显式 room send 时，以读取的版本作为 basedOn，版本过时先核验，不能盲目重发。

私聊 inbox 仍返回私有通知；群 inbox 的 notifications 字段仅返回当前 Agent 的内部委派结果，不属于公开 messages。对 notifications 使用 inbox ack 确认。正文截断时用 message get 分段展开。

`--mentions ID,ID` 将对应成员的列表提升为 @消息，其余成员仍获得新增消息。所有成员有独立检查进度，没有全局已读状态或指定协调员；普通正文同样进入其他成员列表。正文里的 @名字只是文字，结构化 mentions 才有 @ 优先级。用户消息会唤起群成员；被用户停止的成员不会被其他 Agent 的消息恢复。

草稿操作：
```
raftctl draft resolve --id DRAFT --action retry --based-on CURRENT_VERSION --request-id NEW_ID --json
raftctl draft resolve --id DRAFT --action revise --body '修改后的正文' --based-on CURRENT_VERSION --request-id NEW_ID --json
raftctl draft resolve --id DRAFT --action discard --request-id NEW_ID --json
```

request.status=answered 表示自己已回应关联的用户请求，成员的更新不是新的用户请求；相同内容的新用户消息仍是新请求。再次回应须提供 --contribution '新增事实或纠错说明'，否则 retry/revise/force 都继续 held。retry/revise 仍检查新鲜度。`--action force` 显式越过版本检查，会留痕；不能自动循环 force。草稿变更是新操作，使用新 request-id。

以宿主 clock 中的当前日期和时区判断待办；旧消息里的“今日”按原消息日期解释，已过期事项不可继续写成今天待办。未重新核验资料时注明来源日期，不声称最新查询。

显式交接完整示例（先读取真实 version，替换全部占位符）：
```sh
raftctl inbox list --room ROOM_ID --json
raftctl room send --room ROOM_ID --based-on VERSION --body '请核验这条新增事项' --mentions TARGET_AGENT_ID --request-id UNIQUE_ID --json
```
正文选项是 `--body`，不是 `--text`；`--based-on` 与 `--request-id` 不可省略。收到 held 时先核验变化；发送成功后不要重复输出同一正文。

当前群新增列表工具：
```sh
view_inbox --request-id UNIQUE_ID
# 等价命令
raftctl view_inbox --limit 20 --request-id UNIQUE_ID
```
request-id 可省略，由 CLI 生成；结果不确定时按返回 ID 重试。返回 status/label、messages 和 remaining；读取的本批只移出调用者列表，公开历史不删除。最多 20 条、24000 字正文；截断部分用 message get 和 nextOffset 获取。其它群用 inbox list 只读查询，不可通过 view_inbox 消费其它群，以免新消息落进错误会话。
`view_inbox --ids ID,ID` 按预览中的 ID 展开当前群正文，不消费其它新增消息，不更新运行观察版本。无 ids 时仍按批消费；请求已回应与消息已投递是不同状态。
运行中收到 @ 提醒时先读取并考虑调整动作，不盲目取消已经执行的操作。不输出“已收到”“已完成回复”等占位总结。inbox list 仍为只读历史，不消费新增列表。
