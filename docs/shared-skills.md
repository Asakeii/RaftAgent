# 共享 Skill 与按 Agent 加载

## SDK 核查

2026-09-17 查阅 https://platform.claude.com/docs/en/agent-sdk/skills ，核对 package-lock.json 和本地 @anthropic-ai/claude-agent-sdk 0.3.267 的 Options.plugins、Options.skills 与 Query.reloadSkills 类型。SDK 支持本地插件与名称白名单，但未提供运行中替换白名单的 Query 方法。为保留同一轮发布新 Skill 后原生热加载，本实现使用本地插件配置视图加 skills: "all"，视图中仅含当前 Agent 启用项。所有发现、正文加载、执行及刷新由 SDK 实现，不创建自定义加载器。关闭 bundled skills，settingSources 仍为空，不引入 MCP。

## 数据流

共享 sources/<id> 存放可维护源码，releases/<id>/<hash> 存放不可变发布快照；AppState.skillCatalog 登记名称、命名空间、维护者和最新发布版本。Agent.skillIds 记录启用的共享 ID。views/<agentId>/<plugin>/skills 下只有指向发布版本的自动生成符号链接。内置 raft 与自建 raft-local 保持已有调用名称。

用户可在对话上方 Skills 面板配置启用项、查看源码路径、发布总目录的修改。新 Agent 默认启用内置能力。允许空列表；名单只是上下文和 Skill 工具的选择范围，不是文件读取隔离，凭证不进入共享包。

Agent 仍可在工作目录起草，通过现有 raftctl skill publish 提交；宿主校验后更新共享源码副本与版本。只有原维护者可更新其 Skill，其他 Agent 不能覆盖同名条目。全局串行发布防止共享登记竞争。用户通过已鉴权 HTTP 接口可从固定总目录发布已有 Skill，不能注入任意来源路径。Agent 无权配置其他成员的启用项。

发布者在当前 Query 原生刷新；其他运行保持其视图，下一轮或显式刷新后获取新版本/配置。停用不会删除共享源码、历史版本、其他成员的配置，也不能抹去已经进入上下文的说明。

## 迁移与恢复

首次以持久 schema marker 将旧发布登记迁移为共享库与启用项，先写完整发布文件，再原子提交 SQLite 状态。旧目录保留，同名不同来源分配不同 ID，配置校验防止命名冲突。源码目录若已存在则保留，支持上次迁移中断后的重试。内置模板只在未登记时导入，不覆盖用户已维护的源码。启动阶段迁移失败会释放服务锁。

验证包含：共享复用和所有权、独立启用、不可变版本、迁移重入/同名冲突、真实 SDK 第二个 Query 的启用停用、原生热发布，以及配置界面操作。
