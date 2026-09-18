# 每成员新增列表与 view_inbox

发布前检查与请求关联见 [群聊正文发布](group-default-replies.md)。

取代单一协调成员筛选消息和仅目标成员唤醒的旧规则。消息共享可见，每个成员独立检查。

## 生命周期

1. 群消息入库并推进群版本，所有其他成员的待检查列表出现该消息。自己的正文不进入自己的列表。用户消息恢复群成员的 idle 状态；普通成员消息不绕过用户手动停止。
2. 每个 `(agentId, roomId)` 有持久消费游标，按共享消息序号派生待检查列表，避免复制正文。三态：`none/未新增`、`new/新增消息`、`mentioned/@消息`。@ 是当前成员的优先级，不是排他收件。
3. 空闲成员由 Scheduler 唤起（最多并发 3）；优先有 @ 的成员/场景。同场景按序取一批消息，将来源、120 字预览、请求关联与本人回应状态作为 SDK 用户输入，完整正文用 view_inbox --ids 选择读取，原子记录运行和推进已投递批次的游标。本批不会因为模型沉默又重新拉起。已读条目移出列表，公开历史不删除，不创建群已读回执。
4. 运行期间，PreToolUse、PostToolBatch 提供状态提醒，不主动灌入其它场景正文。当前群有 @ 时提示先调用 view_inbox 并判断是否调整下一步。Stop Hook 在结束前对每批新 @ 提醒一次，避免无限阻止结束；未消费的消息在下一次空闲时重新排队。已经执行中的工具不被强制打断。
5. 群回复也是新增消息，其他成员可以检查，但无新事实/纠错/任务时应调用 room silence，不发送收到/完成的相互确认。用户要求“各位打招呼”时，每个成员均需回应。

## 本地工具

SDK 原生 Bash 调用 `view_inbox` 或 `raftctl view_inbox`。沿用本地工具 → CLI → 本地服务身份，不引入 MCP。

```
view_inbox --limit 20 --request-id UNIQUE_ID
```

`view_inbox --ids ID,ID` 可展开已投递预览对应的正文，不消费其它新增消息；分页或按 ID 读取不推进运行观察版本，完整消费新增列表后才更新该版本。

返回当前群 `status/label/count/mentionCount/messages/remaining`。request-id 可省略，由 CLI 自动生成；显式 ID 的重试在同一 run 内幂等，不消费新到达的消息。最多 20 条、正文总计 24000 字、单条 6000 字；截断保留 message ID、totalChars、nextOffset，可用 message get 展开。remaining 仍有 @ 时继续读取。

消费仅限当前群；其它群用 inbox list/message 检索只读访问，避免读取改变回复目的地。内部委派通知保持独立，view_inbox 只推进 roomInboxCursors，不推进私有通知的 sceneNotices。停止群聊会同步取消两个队列的当前待办。

旧数据保留历史和原消费位置；没有 roomInboxCursors 时继承 sceneNotices，不采用上一版 triggerAgentIds 限制。之前未交给某成员的历史仍可由该成员检查一次。读取工具结果代表本批已投递，不保证模型阅读了长文本的截断部分，也不伪装成业务任务完成。

## SDK 与验证

核查实际 TypeScript SDK 0.3.267 的 PreToolUse.additionalContext、PostToolBatch.additionalContext、Stop 的 decision/block、HookCallback；官方参考：

- https://platform.claude.com/docs/en/agent-sdk/typescript
- https://platform.claude.com/docs/en/agent-sdk/hooks

SDK 继续管理执行循环、恢复与上下文压缩。自定义部分仅负责 Raft 群消息列表/持久消费位置和场景路由，因为 SDK 不管理这些应用数据。

测试覆盖三态与成员独立、全员空闲唤醒、@优先、批次消费/幂等/重启、长文本边界、跨场景拒绝消费、内部委派不丢失、运行中提示、Stop 防无限循环。tests/inbox-sdk-smoke.ts 使用本地模拟供应商和真实 SDK/Bash/CLI/socket，验证工具前提醒及 Stop 继续同一个 run 读取新 @；不调用外部模型。
