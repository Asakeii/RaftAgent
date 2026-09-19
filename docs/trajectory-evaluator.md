# 内置轨迹裁判

应用默认提供 `raft-trajectory-judge` v1.0.0。在「监测系统 → 执行日志 → 运行详情 → 轨迹裁判」编辑 Case 目标及规则，点击开始评测。没有 API Key 时保留入口并提示配置，不自动调用模型。

设置中的「评测模型 · 内置轨迹裁判」允许指定模型名；留空继承当前模型，复用当前 Anthropic 兼容端点与 API Key。配置在启动评测时快照固定，后续设置变更不影响进行中的评测。

## 参考方案与 SDK 核验

- [美团 VitaBench TrajectoryEvaluator](https://github.com/meituan-longcat/vitabench/blob/main/src/vita/evaluator/evaluator_traj.py)：参考其每窗口 10 条轨迹、重叠 2 条、携带逐规则状态并据新证据修正判断的机制。本实现将窗口单位定义为本地保存的证据项，不宣称复现 VitaBench 基准分数。
- [Claude Agent SDK 结构化输出](https://platform.claude.com/docs/en/agent-sdk/structured-outputs)
- [TypeScript API](https://platform.claude.com/docs/en/agent-sdk/typescript)

已核对项目锁定 SDK 0.3.267 的 Options 与结果类型。复用 `query`、`outputFormat: json_schema`、`structured_output`、AbortController、`maxBudgetUsd`、`maxTurns`；SDK 负责单次模型调用与结构化输出重试。宿主只负责业务规则状态、窗口编排、证据快照与持久化，这些不是 SDK 自带的业务评测能力。

每个窗口使用独立 query，不 resume 被测 Agent，也不保存评测 SDK 会话。关闭业务工具、Skills、插件、自动记忆和项目设置，不注入 Raft 服务 socket/token。SDK 内部 StructuredOutput 工具用于提交评分，真实 SDK + 本地模拟端点已验证可用。兼容服务若不支持该能力，会显示评测出错，不回退成自由文本猜分。

## 数据链路

1. 校验原运行已结束，冻结目标、规则、模型名和环境配置。默认单 Run，可显式选择同一 Trace 的关联 Run；相关 Run 尚在运行时拒绝启动。
2. 分页读全 Trace 事件，补充运行上下文、带 runId 的公开消息和草稿状态。按时间排序，脱敏并生成稳定引用及 SHA-256 快照。
3. 每窗口最多 10 条证据，重叠 2 条；输入包含当前证据和上一窗口所有规则的状态、理由、引用。
4. 裁判返回每条规则的 `pass / fail / unknown`、中文理由及证据引用。宿主验证规则集合完整、ID 不重复、引用属于当前窗口或历史状态；通过/失败必须引用证据。
5. 保存每个窗口的全量规则状态。后续证据可以推翻早期通过，修复可以改变失败；已发生且明确禁止的副作用不能因后续成功消失。
6. 必须项任一失败则整体失败；必须项全部通过才整体通过；否则待判定。参考项独立展示，不改变整体判定。空规则与没有必须项的 Case 拒绝执行。

## 历史、中断与费用

记录写入独立 `evaluations.sqlite`（WAL，0600）。每次评测保留完整快照、目标、规则、窗口状态、模型名和裁判版本。可选择最近 30 次记录，查看证据及载入历史 Case 重评。

最多同时运行两项，同一 Run 不重复并发。每次最多 10 分钟、2 美元 SDK 估算预算，每窗口最多 4 个 SDK turn。停止或服务退出会中止 query；模型错误、格式错误、非法引用与中断统一保留未完成结论，费用标记可能不完整。重启将遗留 running 标记为 interrupted，不自动重试或扣费。

裁判费用单独标为 **SDK 美元估算**，不计入被测 Agent 的人民币成本。单独配置的裁判模型未必与主模型同价，因此不套用主模型的元/百万 tokens 单价。预算是 SDK 报告值，不是服务商实际账单承诺。

## 边界

- 这是轨迹评测入口，本身不执行 Case 重放或真实环境验收。未通过结果可进入 [Skill 进化](skill-evolution.md)，对无脚本的文本型本地 Skill 执行隔离文件回归；完整业务 Case 集、数据库/外部副作用验收仍不包含在内。
- Trace 关联范围可能跨会话，并不等于完整业务 Trial；用户界面明确标注。
- 日志中的成功退出、工具返回或 Agent 自述不足以证明业务成功。无法观察的产物性质应判未知。规则应写成可被当前证据验证的条件。
- 单条证据最多约 6000 字符；超过 800 项或总快照超过 200 万字符拒绝启动。证据已截断或原运行完整性不明时，整体不可判通过。
- 引用检查证明证据 ID 存在，不证明模型的语义判断必然正确。尚未用人工标注 Case 校准裁判准确率。

## 验证

- `npm run check`：类型检查、单元/服务测试、生产构建。
- `npx tsx tests/evaluation-sdk-smoke.ts`：真实 SDK 对本地模拟 Anthropic 服务验证原生结构化输出与无业务工具。
- `npx tsx tests/evaluation-ui-smoke.ts`：Chrome 自动验证模型设置、默认入口、启动、证据、窗口状态、历史与 390px 窄屏。

测试不读取真实 Key、不调用付费模型。评测测试覆盖长日志分页、跨窗状态修正、配置快照、鉴权、非法引用、截断、取消及重启恢复。
