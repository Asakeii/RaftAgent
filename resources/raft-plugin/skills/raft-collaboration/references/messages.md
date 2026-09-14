# 消息

`raftctl room changes --room ID --json` 查询历史第一页及当前版本。使用返回的 nextCursor 继续 `--cursor N`。不能以部分历史声称已了解所有变化。

inbox 的 `nextCursor` 是最后一条消息 ID，即使该消息已经确认仍可用于继续读取；也可不带 cursor 重新查询剩余未读消息。

发送时 `--mentions ID,ID` 可显式 @ 群成员。收件人是当前房间成员，自己的消息不触发自己唤醒。

草稿操作：
```
raftctl draft resolve --id DRAFT --action retry --based-on CURRENT_VERSION --request-id NEW_ID --json
raftctl draft resolve --id DRAFT --action revise --body '修改后的正文' --based-on CURRENT_VERSION --request-id NEW_ID --json
raftctl draft resolve --id DRAFT --action discard --request-id NEW_ID --json
```

retry/revise 仍检查新鲜度。`--action force` 显式越过检查，会留痕；不能自动循环 force。草稿变更是新操作，使用新 request-id。
