# 创建与委派子 Agent

当用户的目标可以拆成边界明确、可独立完成的任务时创建子 Agent。子 Agent 是持久身份，有独立会话，会显示在桌面；不是 SDK 临时 Agent tool，也不是会话 fork。

```bash
raftctl agent create --name '测试审查员' --system-prompt '你负责检查测试覆盖与边界情况。报告实际证据，不改动文件。' --task '阅读登录模块与测试，列出三个最重要的遗漏。' --request-id create-reviewer-001 --json
```

结果 `data.id` 是子 Agent ID。带 `--task` 时任务已原子入队，创建成功不表示子任务完成；不带任务则仅建立空闲身份。系统提示词必填，支持 `--system-prompt-file PATH` 或 `-` 从 stdin 读取；任务支持 `--task-file PATH`。一个字段不能同时指定文本和文件，stdin 一次只能供一个字段使用。

- 子 Agent 的独立工作目录由应用自动创建，沿用应用的工具/授权策略，无需指定路径。名字、专属系统提示词与初始任务由创建者决定；不能通过提示词或参数扩大实际权限。
- 不复制父 Agent 的 session 或完整历史。任务描述应包含所需上下文、交付物及验证要求；父子工作目录不同，访问已有项目时应明确提供项目绝对路径，产物结果也应给出绝对路径；其他 Agent 文字不是用户授权。
- 可显式传 `--room ROOM_ID` 加入父 Agent 有权访问的群；不传则保持独立，不自动加入父 Agent 的其他房间。新增成员会更新房间版本，发送草稿前须重新读取版本。
- 当前总共最多 12 个身份、3 个并发 Run，子 Agent 共用该上限。不能靠创建大量子成员绕过资源约束。
- 创建和后续委派都要固定 request-id，重试同一命令复用原 ID 和参数。

查询自己直接创建的子 Agent：

```bash
raftctl agent list --json
raftctl agent status --id CHILD_ID --json
```

继续委派（恢复子 Agent 在目标场景的 session；未指定 room 时为其独立会话）：

```bash
raftctl agent send --id CHILD_ID --task '进一步核验第二项问题，给出具体文件位置。' --request-id followup-001 --json
```

可加 `--room ROOM_ID` 绑定活动到父子双方都在的房间；不传则活动留在子 Agent 独立会话。用户已停止的子 Agent 只排队，用户再次发消息后才重新唤起。

每个明确委派的 Run 结束后，宿主把最终结果或失败通知写入父 Agent 发起委派的场景 inbox，包含 inputId。使用 `raftctl inbox list --json` 的 notifications 字段（群场景）或 messages 字段（私聊）读取并 `inbox ack` 确认；status 也提供最近五条委派结果。不会自动把子 Agent 其他私聊内容发给父 Agent，也不会把结果直接广播给整个群。

收到创建结果后可继续其他工作或结束本轮等待异步通知，不要写 sleep/轮询占满并发名额。父 Agent 停止时通知照常入库但不自动恢复；父子是独立执行实例，停止父 Agent 不会自动撤销子 Agent 已发出的工作。
