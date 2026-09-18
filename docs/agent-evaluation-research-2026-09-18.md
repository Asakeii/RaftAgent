# 长程 Agent 与本地助手自动评测调研

调研日期：2026-09-18。对象：当前 RaftAgent，Claude Agent SDK TypeScript 0.3.267。

本次只阅读公开资料、当前源码与测试，并形成方案；未修改运行代码、安装评测平台或调用真实模型做实验。以下明确区分已核实的来源事实、源码事实和建议。

## 1. 结论与选型

建议先建设**复用当前服务、SDK 和 CLI 的本地薄评测执行器**，采用“环境状态验收 + 轨迹约束检查 + 经校准的模型评分”，然后按需要接入实验管理平台。此建议基于当前项目已有的服务注入入口、工具/Skill 追踪、会话隔离与成本快照，而非宣称现成平台已支持 RaftAgent。[S1–S4、S7–S8、S12–S14]

几类方案解决不同层的问题：

| 层 | 可借鉴或接入的方案 | 对本项目的判断 |
|---|---|---|
| 评测工程方法 | Anthropic Agent evals、美团评测白皮书 | 立即采用其任务、trial、grader、环境隔离与回归方法 |
| 保留现有 Agent 的执行框架 | EvalScope External Agent Bridge、Inspect Agent Bridge | 可选外层框架；仍需 Raft 的服务与业务状态适配，不用另写 Agent 循环 |
| 评测资产和实验平台 | Coze Loop；轻量路线可考虑 promptfoo | 多人维护评测集与评分器时更有价值；不能代替本地环境准备和业务验收 |
| 多轮交互与长期个性化 | VitaBench、VitaBench 2.0 | 借鉴模拟用户、多会话任务链、偏好更新与重复运行 |
| 异步、动态长程环境 | Gaia2 | 借鉴事件驱动场景与环境状态评分，适合后续工具/CLI 能力扩展 |
| 桌面、办公真实产物 | OSWorld、TheAgentCompany | 借鉴可重置环境与执行结果验收；不能把 Linux/模拟应用成绩当作 macOS/WPS 能力证明 |

## 2. 国内大厂公开资料

### 2.1 美团：评测对象是完整系统

**《Agent 评测白皮书》系列01：Agent 评测全览**（2026-09-10）要求固定评测集、固定标准和尽可能贴近生产的执行环境，强调离线回归、在线监控、Case 挖掘归因、Trace 观测与评测资产。[S4]

**Agent评测漫谈**（2026-08-07）将 Agent 与 Prompt、Skill、工具链、记忆、状态管理、业务流程一起评估；长程场景看 `prompt—expected_behavior—trace`，从结果、过程、效率与风险分层检查。Rubric 尽量拆成“是/否/未知”，并校准人与评分器的一致性。[S3]

对 Raft 的启示：最终回答质量只是一个分项；群聊路由、私聊边界、过期草稿、任务回传和工具错误恢复都属于产品质量。文章中的一致率阈值与业务收益为案例/示例，不是通用保证。

### 2.2 VitaBench：自动模拟用户与长轨迹评分

VitaBench 1.0（官方介绍 2025-11-02）包含工具环境、用户模拟器和原子 Rubric；评估器使用重叠滑动窗口检查长对话，追踪 Rubric 状态，支持多次运行。其任务来自外卖、到店、旅行等生活场景。[S5]

可借鉴：让模拟用户逐步补充信息、回答澄清、改变要求，而非只给一条完整提示词。长轨迹评分可分窗口，但需要最终汇总和交叉检查，不能漏掉后文撤销/更正。

**VitaBench 2.0**（官方 README 记载 2026-06 发布）转向长期个性化：从跨多次对话的零散行为中推断、使用、更新用户偏好。官方数据为 56 位用户、771 个子任务；提供 `null / groundtruth / full_context / rewrite / rag / rag_cache` 记忆方案与自定义 memory class。[S6]

对本地助手特别有用：

- 同一合成用户经历一串任务，检查偏好是否被正确记住和使用。
- 偏好变更后，检查新事实是否覆盖旧事实；一次性要求不应被错误固化成长期偏好。
- 比较无记忆、完整历史、摘要记忆、检索记忆；完整历史是对照基线，不保证理论最优。
- 同一任务链内部保留指定记忆，独立重复 trial 之间重置；否则既无法测记忆，也无法保证重复试验公平。

边界：生活服务域任务不能直接验证本地文件或群聊；多会话序列也不等于真实运行数周的系统稳定性。

### 2.3 Coze Loop：管理评测闭环

官方 README 确认评测集、评估器、实验管理和 Trace 观测，以及私有部署方案。官方 IDL 将评估结果关联到实验、数据项、turn、评分器版本和 trace，并包含评分理由、人工修正等字段。[S7]

适合借鉴或复用：版本化评测集、评分器与实验；从失败 Trace 沉淀案例；人工纠正评分；查看质量与效率变化。

边界：本次细项依据 README 与源码静态核实，未部署验证；开源版与商业版功能不能默认等同。没有证据表明它会自动重置 Raft 工作区、启动完整服务、操作 macOS 或判断本地任务完成。这些仍需执行适配层。

### 2.4 EvalScope：保留已有 Agent 的外部评测

External Agent Bridge 官方文档说明：通过本地协议桥接运行已有 CLI，记录 AgentTrace，保留 Agent 自身的执行流程；支持 local/docker 环境、每样本 timeout、skills_dir 和自定义 AgentRunner。官方 README 于 2026-05-22 公告该能力。[S8]

与当前项目最相关的点：评测外壳可以控制输入、环境、预算与收集产物，而无需换掉 Claude Agent SDK。

边界：直接测 Claude Code CLI 测不到 Raft 的群聊调度、私有上下文与任务回传；需要一个启动 Raft 服务、投递场景并导出证据的 runner。桥接可能改变模型协议、参数与认证方式，应记录这些差异。其新 HOME/认证隔离机制也不能替代整个本地助手环境的隔离。

## 3. 前沿方法：四类能力分别评

### 3.1 单次长任务：结果、轨迹与可靠性

Anthropic **Demystifying evals for AI agents**（2026-01-09）区分任务、trial、grader、环境与执行轨迹，强调独立试验的干净环境、从真实失败案例起步、优先可执行检查，并用经过校准的模型评分补充主观维度。[S1]

适配建议：不要要求每次走相同工具路径；把确定的业务约束写成判定项。允许不同实现，只要产物正确、必要约束满足且副作用符合要求。

Anthropic **Effective harnesses for long-running agents**（2025-11-26）讨论长任务跨上下文窗口时的进度交接、增量工作和验证。[S2] 它是执行工程文章，不是现成评测工具。可据此设计“压缩/恢复后能否继续正确完成”的压力场景。

### 3.2 长期助手：记忆更新而非只找回事实

采用 VitaBench 2.0 的任务序列思路，分别测记住、使用、更新、不当泛化四种能力。[S6]

当前 Raft 按 Agent × 场景维护 SDK 会话，运行配置设置 `autoMemoryEnabled: false`。这证明存在会话恢复机制，不证明已经具备独立的长期偏好记忆系统；后者应作为单独实验问题，避免把 resume 历史当作完整记忆产品。

### 3.3 动态任务：评测时环境也在变化

Gaia2（2026）的官方评测指南覆盖执行、搜索、适应性、时间、模糊要求，以及 Agent2Agent、Noise 等能力；标准 gaia2-run 每场景运行 3 次。其环境事件携带时间及依赖关系，能按计划改变环境并检查约束。[S11]

最新 **Gaia2 CLI** 将应用 CLI 放入容器，经统一 HTTP runtime contract 启动被测 Agent，依据场景 oracle 评分并提供可查看的 Trace；已有 OpenClaw/Hermes 等 runtime。原文概括为 “grades tool use against the scenario oracle”。它比仅提供 Python 工具函数的环境更贴近 Raft 的本地工具 → CLI 路线，但仍需要 Raft runtime adapter。其 CLI 运行涉及 Podman、Python/uv 等依赖，不能视作零成本接入。[S11]

官方多语言版本包含简体中文；对应 judge prompt 也要同步，不能默认英语评分器对中文助手同样有效。[S11]

Gaia2 的动态、异步环境与 CLI 运行适配为事件驱动评测提供参考。[S11] 对 Raft 可设计：读完资料后收到新约束、工具返回期间出现新群消息、外部状态改变、执行中断后恢复。

这些是本项目建议场景，并非声称 Gaia2 已提供 Raft 插件。事件最好绑定“首次读取/首次写入/收到回执”等可观察条件；固定睡眠若无法保证发生阶段，会让测试结果受机器速度影响。

### 3.4 本地办公：用可检查的环境事实评分

OSWorld 原版发布于 2024，OSWorld-Verified 于 2025-07 更新。其 reset 恢复虚拟机快照，evaluate 根据配置读取环境结果并调用验收指标；保留截图、操作与视频。[S9]

TheAgentCompany（2024）将办公任务放在预置 GitLab、Plane、ownCloud、RocketChat 等服务环境中；任务使用初始化与 eval.py 验收，要求重置依赖服务数据、等待健康检查，主要按结果评分，里程碑可提供部分分数。完整部署较重，且模拟同事和主观评分可能增加模型开销。[S10]

两者提供真实计算机/办公环境中的任务与执行结果评估范式。[S9–S10] 对本地助手最重要的是：文件确实生成、数据正确、原始材料保留、业务状态确实改变。

对于表格，检查内容、公式及结构；对于报告，检查可解析性、必要内容、来源和实际呈现；对于脚本，检查测试及输出；对于跨应用操作，检查应用/服务状态。截屏和最终回复可作为辅助证据，但不能覆盖这些检查。

Linux 容器适合文件、代码和模拟服务；真实 macOS 原生应用仍需匹配的独立测试环境。重置会话目录不等于重置整台桌面。

## 4. 当前代码可以复用什么

以下来自本轮源码静态核实，未运行真实模型验证。

| 已有能力 | 源码位置 | 可支持的评测工作 |
|---|---|---|
| 独立 dataDir、可注入 runner/historyReader 的服务入口 | [server.ts](/Users/asakei/Documents/CodeBase/RaftAgent/src/server.ts:30) | 创建隔离案例服务；分别运行模拟 SDK、真实 SDK 与真实模型 |
| Agent × 场景会话与 resume | [conversation-context.ts](/Users/asakei/Documents/CodeBase/RaftAgent/src/conversation-context.ts:10)、[runtime.ts](/Users/asakei/Documents/CodeBase/RaftAgent/src/runtime.ts:186) | 多轮场景、上下文边界、恢复测试 |
| Run/Trace、工具事件、压缩事件、SDK 用量 | [trace.ts](/Users/asakei/Documents/CodeBase/RaftAgent/src/trace.ts:113) | 收集执行证据、成本与故障位置 |
| Skill 版本、命令 requestId、重放与脚本回执 | [skill-trace.ts](/Users/asakei/Documents/CodeBase/RaftAgent/src/skill-trace.ts:21) | 检查加载/执行/重放；定位能力调用失败 |
| 单次运行人民币价格快照 | [model-pricing.ts](/Users/asakei/Documents/CodeBase/RaftAgent/src/model-pricing.ts:5) | 统计 token 成本；比较同一用例不同版本 |
| 真实 SDK + 模拟模型，以及 opt-in 真实模型脚本 | [context-sdk-smoke.ts](/Users/asakei/Documents/CodeBase/RaftAgent/tests/context-sdk-smoke.ts:1)、[group-handoff-live-smoke.ts](/Users/asakei/Documents/CodeBase/RaftAgent/tests/group-handoff-live-smoke.ts:1) | 已有分层测试范式，可提炼成案例，不等于已有批量评测平台 |

目前在 src/ui/tests 范围未发现完整的评测集、实验、独立 trial、通用 grader 与版本对比闭环。现有监测与成本统计是评测基础。

两项边界需要纳入实验说明：

1. 运行配置目前是 `maxTurns: 16`、`maxBudgetUsd: 2`；调度还有连续 30 次运行限制。[runtime.ts](/Users/asakei/Documents/CodeBase/RaftAgent/src/runtime.ts:43) 长任务碰到上限需报告为预算/轮次终止，不能直接归因为推理能力不足，也不能在本轮调研中悄悄修改限制。人民币展示价不会自动替换 SDK 美元预算口径。[S14]
2. `script.end` 的退出码只证明进程回执，`businessStatus` 仍为 `not_verified`；`loaded_only` 也不必然失败。指导型 Skill 不需要运行脚本即可发挥作用。真正结果还需要外部验收。[skill-execution-tracing.md](/Users/asakei/Documents/CodeBase/RaftAgent/docs/skill-execution-tracing.md:14)

## 5. 推荐的自动评测链路

以下均为方案建议，尚未实施。

```text
版本化场景集：任务、初始文件/状态、用户事件、验收标准、预算
   ↓
创建独立 Trial：工作区、数据库、会话/配置、Skill 版本、模拟服务
   ↓
调用现有 Raft 服务 → 现有 Scheduler → Claude Agent SDK → 本地工具/CLI
   ↕
场景控制器：用户补充信息、事件触发、错误注入、停止/恢复
   ↓
收集：所有关联 Run、Trace、产物、业务状态、费用、结束原因
   ↓
确定性验收 → 轨迹约束检查 → 语义 Rubric 评分 → 不确定项复核
   ↓
重复运行与版本比较 → 失败证据 → 回归用例
```

### 5.1 Trial 的边界

一个 Trial 对应一次完整业务任务；它可能包含多个 Run、多个 Agent、多次用户交互甚至多个会话。不能将某个 Run 的 `done` 或暂时无活动 Agent 当作任务成功。

场景明确结束条件：验收结果、终止事件、预算、是否还有必须处理的输入/子任务。需要用户补充信息可以是正确行为；若测试没有提供模拟用户响应，应标记测试环境阻塞，而非默认 Agent 失败。

记录 `caseVersion / codeCommit / sdkVersion / model / endpoint / prompt / skillVersions / environment / judgeVersion / budget`，并建立 Trial 到全体 Run 的归属关系。并发群成员不一定共享一个完整业务 trace，不能只取第一条 trace 就结算整个任务。

### 5.2 三层 grader

| 类型 | 适合检查 | 不宜承担 |
|---|---|---|
| 确定性程序 | 文件、结构化字段、哈希、公式、测试结果、数据库状态、消息目的地、重复副作用 | 仅凭文本正则判断完整业务质量 |
| 轨迹/行为规则 | 是否先获授权；是否重复写入；新约束是否影响后续动作；是否泄露私聊内容 | 强制唯一工具顺序，或将日志缺失自动判成“没有发生” |
| 模型 Rubric | 报告完整性、来源支持、回答是否真正解决用户问题、澄清是否合理 | 覆盖客观状态检查；接受 Agent 自报成功；把未知硬判为通过 |

评分输出至少包含 `pass/fail/unknown`、理由和证据定位。客观硬约束失败不能被好看的文本分数抵消。评分器读只读证据，隐藏答案/验收脚本不进入被测 Agent 的可访问工作区。

自动评测不等于零人工：首批标准、主观评分校准、争议项仍需人核验。自动化主要承担反复执行、采证、确定性判分及大量已校准 Rubric。

### 5.3 环境与故障

独立 dataDir 只隔离 Raft 状态；还要处理工作目录、SDK 会话/配置、Skill 投影、进程、网络/服务数据与用户文件权限。仅配置不同路径不是完整安全边界；文件和服务验收可使用隔离账号/容器/虚拟机及受控 fixture，grader 留在边界之外。[S1、S8、S12]

可注入：工具超时、429、无效返回、缺失附件、连接断开、进程在副作用后但回执前结束、历史被压缩、旧事实被更正。恢复后检查“先核验状态再决定重试”，而非只奖励最终成功。

### 5.4 自动生成和扩充案例

先人工确定少量正确的种子任务和验收标准，再做三种扩充：

- 参数化：替换文件名、时间、币种、排序与过滤条件，程序同步生成正确答案。
- 变异：缺失数据、矛盾版本、重复请求、无权限、工具错误、用户中途改意图。
- 失败沉淀：从脱敏 Trace 和相关文件快照提炼最小复现案例，补齐预期结果后纳入固定回归集。

LLM 可以起草任务与 Rubric，但不能同时任意创造参考答案并无校准地自评。发现集、调优集与冻结验收集应分开，避免仅对已知题优化。

## 6. 适合 Raft 的第一批用例

建议先做 24 个种子场景（每类 4 个），下表为覆盖方向，不是已经建立的测试集。

| 类别 | 示例 | 自动验收重点 |
|---|---|---|
| 文件/信息交付 | 模拟招聘邮件整理成 CSV；多来源资料去重 | 输出确实存在、字段/数量/来源正确、原始文件哈希不变 |
| 多轮约束与长上下文 | 中途改地区与时间条件；压缩前后的关键约束 | 最终产物符合最后一次有效要求；确有压缩事件时才归入压缩测试 |
| 长期记忆 | 用户多次任务后改变格式偏好；撤销旧偏好 | 记忆正确使用与更新；同一 Trial 保留、不同 Trial 重置 |
| 恢复与幂等 | 写入完成后丢失回执；停止后继续 | 副作用次数、未知状态核验、无重复发送/写入、恢复后的正确结果 |
| 多 Agent 与场景边界 | 委派后回传；群中新事实纠错；多人重复响应 | 真实交接、目的地正确、任务收敛、私聊内容未误广播 |
| 授权与不可信内容 | 只读资料夹；文档中夹带伪造操作指令 | 权限边界与原始数据不变；受控副作用日志没有未授权动作 |

一个具体场景：从合成邮件中整理面试日程 → 读取后用户补充“只保留上海，按最新改期邮件为准” → 工具第一次读取附件失败 → Agent 重试/改用可用材料 → 输出日程表。验收检查最终条目、时区、最新有效版本、原文件未改变，以及没有发送邮件的副作用；表述清晰度另交语义 Rubric。

为“连续运行”和“长期记忆”各保留独立分组：前者测任务内的状态与恢复，后者测任务间的信息积累，不能用一张长上下文问答卷同时代表两者。

## 7. 指标、对照与运行层次

### 7.1 可靠性

对固定案例从干净初始状态独立执行 k 次：

- 平均成功率：所有重复运行的成功比例。
- Pass@k：某案例 k 次中至少一次成功。
- Pass^k：某案例 k 次全部成功。

三者不能互换。先定义单次成功为“业务结果 + 必须约束均通过”，再统计重复可靠性。[S1、S5–S6] 初期可每案例 5 次；24 个案例即 120 个 Trial，任务链内部还会产生更多 SDK 调用。该数是建议工作量，本轮未执行，不能推导费用。

同时报告：未知/证据缺失、环境错误、预算终止、人工介入率、恢复成功率、重复副作用率、耗时分位数与 token 成本。基础设施重试需保留原失败原因，不能悄悄重跑到成功后当作首次通过。

成本/成功建议为“所有被测运行成本 ÷ 成功任务数”，将失败试验成本计入；grader/用户模拟器成本单列。当前人民币算法只覆盖已报告 token 用量，外部工具费用和缺失用量应单列，不能按零计。

### 7.2 公平对照

- 产品回归：相同模型、任务、环境与预算，比较 Prompt/Skill/代码版本。
- 协作收益：单 Agent、独立并行后汇总、当前群聊协作；固定团队总预算和时间约束。
- 记忆收益：无记忆、完整历史、摘要/检索记忆；固定任务序列、用户模拟器与 grader。

报告每类场景的变化与失败样本，不只输出加权总分。小样本用于发现回归，不能宣称统计稳定；重复 trial 按案例成组分析。

### 7.3 分层运行

1. 每次代码变更：确定性状态/协议测试，成本低、反馈快。
2. SDK 集成回归：真实 SDK + 本地模拟模型，测试 Hooks、会话与 CLI 链路。
3. 候选版本：真实模型 + 隔离环境 + 任务重复运行，才评任务完成质量。
4. 后续线上闭环：对已结束轨迹采样评分、脱敏归档、人工校准，再加入离线回归；不要直接在用户真实环境重放有副作用的任务。

## 8. 落地路线比较

| 路线 | 适用情况 | 需要补齐 | 建议 |
|---|---|---|---|
| 本地 TypeScript 薄执行器 + 当前 Trace | 先验证自身业务和恢复机制 | 场景格式、隔离环境、Trial 归属、grader、报告 | 当前第一选择；保留 SDK 和 CLI，不引入新的 Agent 循环 |
| promptfoo + 自定义 TS provider/assertion | 想快速复用结果比较、断言与测试配置 | provider 包装完整任务执行，导出产物和状态 | 轻量备选；不能只将最终文本交给评分器 [S13] |
| EvalScope Bridge + Raft runner | 批量模型/Agent 对比，复用标准基准 | Raft 服务生命周期与场景环境适配 | 第二阶段候选；Python 评测外壳与 TS 产品可分离 [S8] |
| Coze Loop + 本地 runner | 多人维护评测集、版本、评分器和实验 | 数据接入、执行与环境重置、部署维护 | 需要管理平台时接入，先不为本地单项目铺开整个平台 [S7] |
| Inspect + 自定义 agent/scorer/sandbox | 重视隔离环境、研究实验与标准化日志 | 产品 adapter、环境镜像、状态检查 | 能力完整但集成更重；API bridge 默认参数处理需审计 [S12] |

Inspect Agent Bridge 文档当前明确：默认不转发部分生成参数，而由 Inspect 配置决定，可用 `forward_generation_config=True` 调整。做“产品原样回归”时必须核对这类默认值；桥接接通不代表与生产行为等价。[S12]

SDK 原生能力继续用于 query、resume、Hooks、工具执行与用量采集。本次核查未发现覆盖 Raft 场景 fixture、隐藏业务验收、重复试验和版本比较的现成 SDK 业务评测闭环，因此建议补充的自定义边界仅是评测编排和验收层。[S14]

## 9. 来源、时间与证据限制

本次为针对项目的快速工程调研，不是穷尽式系统综述。检索范围为官方工程文章、官方 SDK/框架文档、项目官方仓库与论文页面；中英文均纳入，以 2025–2026 的长程/工具型 Agent 资料为重点，同时纳入桌面评测基础项目。关键词围绕 agent evals、long-running harness、dynamic asynchronous、long-term memory、external agent bridge、Agent 评测、轨迹与环境状态评分。

既有项目调研记录仅用于寻找候选链接；本报告外部结论依据本次实际读取的官方资料。不存在“厂商自报成绩已独立复现”的含义；未复制旧模型榜单作为当前结论。Coze 文档站正文访问有限，细项改由官方 README/IDL 核实；持续更新页面以访问日期为准，真正实验前应固定代码、数据和评分器版本。

本报告由 AI 辅助检索、核对与归纳。源码结论属于静态分析，架构适配属于建议，尚无本项目自动评测实验结果。

### 来源索引

- **S1** Anthropic. *Demystifying evals for AI agents*. 2026-01-09. [原始资料](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
- **S2** Anthropic. *Effective harnesses for long-running agents*. 2025-11-26. [原始资料](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- **S3** 美团技术团队. *Agent评测漫谈 —— 由浅入深讲解Agent评测*. 2026-08-07. [原始资料](https://tech.meituan.com/2026/08/07/Agent-Evaluation.html)
- **S4** 美团技术团队. *《Agent 评测白皮书》系列01：Agent 评测全览*. 2026-09-10. [原始资料](https://tech.meituan.com/2026/09/10/Agent-Evaluation-White-Paper-01.html)
- **S5** 美团技术团队. *LongCat 团队发布 VitaBench：基于复杂生活场景的交互式 Agent 评测基准*. 2025-11-02. [原始资料](https://tech.meituan.com/2025/11/02/LongCat-VitaBench-Agent.html) ；官方仓库：[原始资料](https://github.com/meituan-longcat/vitabench)
- **S6** Meituan LongCat. *VitaBench 2.0: Evaluating Personalized and Proactive Agents in Long-Term User Interactions*. README 记载 2026-06 发布. [原始资料](https://github.com/meituan-longcat/VitaBench-2.0)
- **S7** Coze. *Coze Loop*. 持续更新. [原始资料](https://github.com/coze-dev/coze-loop) ；已核实 IDL：[原始资料](https://github.com/coze-dev/coze-loop/blob/main/idl/thrift/coze/loop/evaluation/domain/evaluator.thrift) 与 [原始资料](https://github.com/coze-dev/coze-loop/blob/main/idl/thrift/coze/loop/evaluation/domain/expt.thrift)
- **S8** ModelScope. *External Agent Bridge Mode*. 持续更新，README 公告 2026-05-22. [原始资料](https://github.com/modelscope/evalscope/blob/main/docs/en/user_guides/agent/bridge.md)
- **S9** XLang. *OSWorld*（2024）及 *OSWorld-Verified*（2025-07-28）. [原始资料](https://github.com/xlang-ai/OSWorld) ；[原始资料](https://xlang.ai/blog/osworld-verified) ；环境实现：[原始资料](https://github.com/xlang-ai/OSWorld/blob/main/desktop_env/desktop_env.py)
- **S10** TheAgentCompany. *Benchmarking LLM Agents on Consequential Real World Tasks*. 2024. [原始资料](https://github.com/TheAgentCompany/TheAgentCompany) ；评测指南：[原始资料](https://github.com/TheAgentCompany/TheAgentCompany/blob/main/docs/EVALUATION.md) ；论文：[原始资料](https://arxiv.org/abs/2412.14161)
- **S11** Meta. *Gaia2: Benchmarking LLM Agents on Dynamic and Asynchronous Environments*. 2026. [原始资料](https://arxiv.org/abs/2602.11964) ；官方评测指南：[原始资料](https://facebookresearch.github.io/meta-agents-research-environments/user_guide/gaia2_evaluation.html) ；CLI：[原始资料](https://github.com/facebookresearch/meta-agents-research-environments/blob/main/gaia2-cli/README.md) ；事件机制：[原始资料](https://github.com/facebookresearch/meta-agents-research-environments/blob/main/docs/foundations/events.rst) 。注意与 2025 前身 ARE 论文区分，不混用不同版本榜单。
- **S12** UK AI Security Institute. *Inspect: Agent Bridge / Sandboxing / Scorers / Eval Sets*. 持续更新. [原始资料](https://inspect.aisi.org.uk/agent-bridge.html) ；[原始资料](https://inspect.aisi.org.uk/sandboxing.html) ；[原始资料](https://inspect.aisi.org.uk/scorers.html) ；[原始资料](https://inspect.aisi.org.uk/eval-sets.html)
- **S13** Promptfoo. *Javascript Provider / Javascript assertions*. 持续更新. [原始资料](https://www.promptfoo.dev/docs/providers/custom-api/) ；[原始资料](https://www.promptfoo.dev/docs/configuration/expected-outputs/javascript/)
- **S14** Anthropic. *Agent SDK reference — TypeScript / Hooks*. 持续更新，核对本地 0.3.267 类型. [原始资料](https://platform.claude.com/docs/en/agent-sdk/typescript) ；[原始资料](https://platform.claude.com/docs/en/agent-sdk/hooks)
