# Skill 实际执行追踪

复用现有 traceId、runId、SDK tool_use_id 和 CLI requestId，不新增 skillInvocationId。traceId 由 Scheduler 创建或沿 originRunId 继承；服务端根据运行 token 解析 actor/run，再从 TraceStore 获取 traceId，不信任客户端提交的 traceId。UUID 沿用现有格式，不宣称兼容 W3C traceparent。

## 证据链

- SDK 原生 PreToolUse / PostToolUse / PostToolUseFailure 记录 skill.load.start、skill.loaded、skill.load.failed，关联 tool_use_id 和 Skill 内容版本。它们仅证明说明加载。
- raftctl 的已认证服务处理器记录 capability.start/end，保留 command、requestId、Skill 归属、耗时、返回/失败及 businessStatus。web.* 明确归属搜索 Skill；协作命令归属协作 Skill，不按“最后加载的 Skill”推断。未启用或未知能力不强行归属。拥有者归属不证明模型读取并遵循了说明。
- Store 幂等返回记录 replayed=true，不重复统计为新的执行。Skill publish 等操作仍可能刷新 SDK，服务返回仅代表处理器返回，不能用于计算外部副作用次数。
- 脚本用 `raftctl skill run --name raft-local:名称 --script scripts/文件 -- 参数`。服务校验已启用 Skill 和 scripts/ 路径、固定发布版本，返回路径；CLI 在原 Bash 沙箱内 spawn，绝不在服务端运行脚本。支持 py/sh/js/mjs/cjs，不通过 shell 拼接参数。注入 RAFT_TRACE_ID、RAFT_RUN_ID、RAFT_SKILL_ID、RAFT_SKILL_VERSION。
- script.start 仅为授权，script.end 是已认证 CLI 上报的进程回执。它不是独立、防篡改的业务证明；拥有运行 token 的进程可以上报。exitCode=0 只表示进程成功，businessStatus=not_verified。kill -9、连接中断、服务退出导致缺失回执时保留未收尾状态，不自动重跑。
- 脚本启动 requestId 不得复用；完成回执同值幂等，不同值拒绝。授权日志未持久化则不运行脚本。脚本参数与输出不写入新增证据事件；SDK 原有工具日志仍按其脱敏规则保存。

## 查看与评测

单次 Trace API 返回 skillUsage，按 Skill ID+版本汇总全量事件，不受事件分页影响。执行详情中可展开“Skill 使用证据”。loaded_only 表示仅观察到加载，execution_observed 表示观察到处理器调用或进程回执，unknown 表示证据不足；同时展示失败、重放、未收尾计数。失败尝试仍属于调用过能力，不能被归为未使用。指导型 Skill 仅加载也可能合理；不能直接把 loaded_only 判成失败。

历史日志没有这些事件；直接 python/node 执行的旧脚本、任意 Bash、第三方入口没有自动 Skill 归属。继承 traceId 本身不代表产生了执行证据，也不提供身份认证。缺少证据不能断言未执行。恢复会话不要求重新加载 Skill，能力入口仍独立记录。版本取当前托管投影，脚本授权后固定此版本；SDK 已缓存旧说明而投影发生热更新的情况不能证明模型实际使用了哪版知识。

## 自建 Skill 的自动接入范围

Agent 在工作区写下 SKILL.md 和 scripts/ 只是草稿。成功执行 `raftctl skill publish` 后，现有发布流程自动登记共享库、为创建者启用、复制不可变发布版本，并调用 SDK reloadSkills 尝试热加载；其他 Agent 仍需各自配置启用。必须同时检查 active=true 和 refresh.status=loaded，不能只根据发布成功声称本轮已加载。

原生 Skill 加载事件和 `raftctl skill run` 的脚本回执按共享库动态解析，不需要为每个新 Skill 修改代码或手写埋点。脚本必须通过该入口运行；直接 python/node、未发布草稿、包外脚本不自动获得 Skill 归属。执行入口支持 py/sh/js/mjs/cjs，不要求指导型 Skill 为了追踪而额外执行脚本。

## 2026-09-18 现有脚本迁移

本地已登记 Skill 中，带脚本的 mail-imap 已迁移：共享源码及维护者草稿的 9 处旧命令改为 `raftctl skill run --name raft-local:mail-imap --script scripts/mail.py -- ...`，通过现有发布流程生成新版本 3542a6f82b6b，再刷新各 Agent 视图。mail.py 字节保持不变，历史发布与备份保留；没有修改消息、输入、会话或成员启用配置。安装目录中的协作 Skill 编写指南也已同步发布，避免旧指南继续教 Agent 直接运行 Python/Node。

使用隔离数据目录、真实 SDK 与原生 Bash 沙箱运行实际 mail.py 的 `--help`，验证 CLI 参数转发、Python 启动、自动上下文和 script.end 回执；未读取邮箱配置、连接邮箱或发送邮件。

## SDK 依据与边界

核对安装的 @anthropic-ai/claude-agent-sdk 0.3.267 及官方文档：
- https://platform.claude.com/docs/en/agent-sdk/skills
- https://platform.claude.com/docs/en/agent-sdk/hooks

复用原生 Hooks、tool_use_id、Options.env、Bash 严格沙箱。SDK 的 Skill 加载事件不提供后续任意 CLI/脚本的可靠 Skill 父子关系，故增加业务入口记录和最小脚本 runner；不重建 Agent 循环、不引入 MCP 或 OTel 基建。业务是否完成仍需服务业务状态、产物校验或评测 Rubric。
