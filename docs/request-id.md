# requestId 自动管理

requestId 保留为操作幂等键和查询标识；正常 Agent CLI 调用不再需要模型生成它。traceId 标识整条任务链路，无法替代同一链路内各个操作的幂等键。

## 分配与重试

- 写命令在 CLI 参数解析时生成 UUID。sendControl 对遗漏的 ID 再做补齐，同一 Command 对象后续发送保留原 ID；skill runner 在授权前固定同一个 ID，用于 start/finish。
- 每个新的 CLI 进程/新命令对象默认是新操作，即使参数相同也不合并。一个 Bash 可执行多个 CLI 命令，因此不能直接把同一个 SDK tool_use_id 当成所有命令的 requestId。
- 正常示例：`raftctl room send --room ROOM --based-on VERSION --body '正文'`，`raftctl room silence`。`--request-id` 仍兼容旧调用，仅用于显式重试已知操作。
- CLI 发送前向 stderr 输出不含业务参数的 request.started（requestId、命令名），stdout 成功/拒绝回执也携带 requestId。传输超时、断连或响应损坏返回 ControlTransportError，保留 requestId 和 outcome=unknown。不会自动重发。
- 结果不明先 `raftctl request status --id 原ID`。确认重试同一次支持幂等的命令时，显式复用原 ID 和原参数；省略 ID 重新调用会被视为新操作。not_found 不证明外部操作未发生。
- requestId 是去重/关联信息，不是授权凭据；权限仍来自服务认证的 run token。

## 各入口的保证

Store 的持久写操作维持原有指纹与缓存结果机制。Skill 发布的重复请求沿用原发布结果，并可能重新尝试热加载。web 请求虽记录请求 ID，但不提供外部搜索去重或完整结果恢复，禁止据此盲目重试。

script start/finish 的回执可通过 request status 查询，严格按 Agent 身份隔离，可查询本 Agent 之前运行的脚本回执。仅有授权记录返回 unknown，完成返回 process_succeeded/process_failed；均不等于业务成功。同一 Agent 的脚本 requestId 跨运行也不得重新启动，避免恢复会话后重跑原脚本。脚本不自动重试，不保证外部邮件等副作用恰好一次。

## SDK 取舍和验证

核对 Claude Agent SDK 0.3.267 的官方 Hooks 文档（https://platform.claude.com/docs/en/agent-sdk/hooks）及本地 tool_use_id、Options.env 类型。保持 SDK 原有 Bash 执行和沙箱；不解析或改写任意 shell 命令，不通过全局环境变量维护“当前工具调用”，避免并发调用混淆。自动 ID 放在一条 CLI 业务操作的边界，无新增 ID 类型。

测试覆盖无 ID 写命令、显式 ID 兼容、同参数新操作、发送成功但响应丢失后复用原 ID、拒绝及损坏响应保留 ID、脚本状态查询/隔离/跨运行防重放。真实 SDK 冒烟测试使用省略 request-id 的 CLI 命令验证自动注入及协作循环。

已安装的协作 Skill 在下次服务启动、持有数据目录锁且 Agent 尚未启动时，自动迁移已知的旧 requestId 指令并发布新版本；保留自定义段落及旧发布快照。迁移可重复执行，源码写入后发布中断可在下次启动继续。不强制重启正在运行的服务。
