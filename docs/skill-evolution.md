# 评测驱动的 Skill 进化（text-files-v1）

入口：监测系统 → 执行日志 → 运行详情 → 选择一条已完成、未通过或待判定的轨迹评测 → Skill 自进化。

首期实现一个可执行闭环：失败证据 → 模型生成候选说明 → 新旧 Skill 隔离回归 → 程序门禁 → 用户晋升 → 可回滚。未通过评测只是改进线索，不保证问题由选中的 Skill 引起；用户选择要改进的能力，回归负责验证候选是否改善指定任务。

## 使用方式

1. 选择该 Agent 已启用的本地 Skill。仅支持无脚本、无二进制文件的文本型 `raft-local` Skill；内置协作能力不能在此修改。
2. 将界面示例替换成真实回归 Case。每条 Case 包含任务 prompt、输入文件 fixtures 和验收 checks。支持 1–8 条 Case，每版每条 Case 重复 2 次。
3. 点击“生成候选并回归”。自动生成候选，再执行两版；不会提前覆盖正式 Skill。
4. 查看改进理由、适用条件、文件差异、每次试验的实际产物和工具轨迹。门禁通过后可点击“晋升为正式版本”。
5. 晋升后支持“回滚到基线版本”。两种切换都拒绝覆盖已变化的正式版本、未发布源码或正在被活动 Agent 使用的能力。

Case 示例：

```json
[
  {
    "name": "复制值并保留原文件",
    "prompt": "读取 input.json，将 value 写入 result.json，并保留原文件。",
    "fixtures": [{"path": "input.json", "text": "{\"value\":42}"}],
    "checks": [
      {"path": "result.json", "kind": "json", "expected": "{\"value\":42}"},
      {"path": "input.json", "kind": "text", "expected": "{\"value\":42}"}
    ]
  }
]
```

- `exists`：普通文件存在。
- `text`：文件全文精确相等，包含空格和换行。
- `json`：解析后 JSON 结构相等，对象字段顺序无关。
- 每条 Case 必须有至少一条内容断言；不能只凭文件存在认证改进。
- 文件名使用相对路径，扩展名限定为 md/txt/json/csv；不接受隐藏文件、链接和路径穿越。要求保留输入文件时，应为它增加 text 断言。

## 数据链路与边界

- 创建实验时冻结原 Skill 全量文本、版本哈希、Case 与 Case 哈希、执行模型/端点、改进模型和执行配置版本。
- 改进器复用设置中的评测模型，留空继承主模型。输入原评测的目标、规则、被引用证据和原 Skill；不发送冻结的回归 Case 及预期文件。
- 原生结构化输出只允许返回改进理由、适用条件、完整替换文件。宿主只接受 `SKILL.md` 和 `references/` 下的说明文档，不允许候选修改名称、脚本、权限 frontmatter、hooks 或验收标准。
- 新旧版均使用创建实验时的主模型配置。每个 Trial 使用独立临时工作目录、独立 SDK query 和独立 Skill 插件副本；重复间不共享会话。奇偶轮交换新旧执行顺序。
- 执行模型仅看到任务、夹具路径和指定 Skill，不得到 checks/expected。只能调用 SDK 原生 Read/Write/Edit/Skill。PreToolUse 对每次调用检查路径和 Skill 名；即使工具已自动允许，仍由 hook 检查。工作目录可读写，插件副本只读；没有 Bash、网络、协作 CLI、服务 token 或 socket。此处是能力和文件工具边界，不宣称完整操作系统虚拟机隔离。
- 必须观察到目标 Skill 成功加载。模型声称成功或 SDK 正常退出都不作为任务通过依据；宿主在运行结束后独立读取实际文件执行断言。
- 每次试验保存产物文本、检查结果、工具轨迹、耗时和 SDK 费用。结束后删除临时工作目录，历史保留在 `evolutions.sqlite`。

## 晋升门禁

同时满足以下条件才允许晋升：

1. 每条 Case、新旧两版、每版两次试验均完整完成，没有重复或遗漏。
2. 不存在 SDK/工具配置/文件采集错误；基础设施失败不能算作基线能力差。
3. 候选的每次试验全部通过。
4. 基线至少一次已完成试验未通过，从而观察到任务正确率提升。两版都通过时不会因文案变化晋升。
5. 费用完整，Case 哈希未变化，主模型/端点未变化；正式 Skill 仍是实验基线，源码无未发布修改。

耗时与费用供比较展示，首期不以速度或成本改善代替正确率门禁。两次重复只是有限样本，不能证明统计显著性或泛化能力；用户应加入真实失败 Case、正常 Case 和未用于原始问题诊断的变体。

## 发布、共享与中断

- 候选并不加入共享 Skill 目录。晋升复用 SkillManager 的内容版本、共享目录和发布串行队列；新版本影响所有启用此 Skill 的 Agent，在下一次运行或原生 reloadSkills 后生效。
- 切换前比较当前版本（CAS）、当前源码内容和活动运行。回滚只能从本实验候选回到其基线；如果已有第三个版本，不越过它强制回滚。
- 切换先保存操作日志，再切换目录和正式登记，最后更新进化状态。重启遇到“正式版本已切换但状态未更新”时据版本恢复；未完成实验不自动继续或重试付费调用。
- 文件系统与两个 SQLite 库不构成分布式事务。若进程恰在源码替换和正式登记之间退出，记录标记中断，源码不一致会阻止后续切换，提示核验；不静默覆盖用户可能修改过的文件。
- 普通 `skill.publish` 仍是原有人工/Agent 发布途径，本功能的门禁只约束进化实验晋升，不宣称所有 Skill 发布都已强制经过回归。
- 同时只运行一个进化实验。生成和所有 Trial 共用 4 美元 SDK 估算预算、10 分钟上限；允许取消。中断/错误保留已有试验，整体不可晋升，费用标为可能不完整。费用不是供应商实际账单保证。

## SDK 能力核验与参考

项目安装并锁定 `@anthropic-ai/claude-agent-sdk` 0.3.267。实现前请求以下官方文档，本轮返回 HTTP 403，因而按项目约定进一步核对本地 `sdk.d.ts`，并用真实 SDK + 本地 Anthropic 兼容端点验证实际行为：

- https://platform.claude.com/docs/en/agent-sdk/structured-outputs
- https://platform.claude.com/docs/en/agent-sdk/skills
- https://platform.claude.com/docs/en/agent-sdk/sandbox

复用原生 query、outputFormat/structured_output、plugins/skills、PreToolUse、AbortController、persistSession、maxBudgetUsd/maxTurns。SDK 负责模型循环与工具执行。自行实现的部分仅是业务 Case/产物验收、候选保存、实验编排、门禁和版本切换。

方案参考：

- [美团 Agent 评测白皮书](https://tech.meituan.com/2026/09/10/Agent-Evaluation-White-Paper-01.html)：重复试验、端到端验收和发布门禁。
- [VitaBench](https://github.com/meituan-longcat/vitabench)：原始轨迹裁判；本功能消费其在 Raft 中的评测结果。
- [Coze Loop](https://github.com/coze-dev/coze-loop)：将版本、数据集和实验结果关联。
- [ReMe](https://github.com/agentscope-ai/ReMe)：提炼可复用经验。本期经验固化为候选 Skill，未引入通用长期记忆系统。

## 验证命令

```sh
npm run check
npx tsx tests/evolution-sdk-smoke.ts
npx tsx tests/evolution-ui-smoke.ts
```

单元/服务测试覆盖：完整闭环、隐藏断言、独立目录、无提升、候选失败、SDK 错误、预算、取消、重启、模型快照、源码冲突、正式版本冲突、Case 哈希和文件边界。

SDK smoke 实际加载本地 Skill、读写文件，并主动尝试越界读写及修改插件文件，确认被拦截。Chrome smoke 验证入口、Case、差异、产物、晋升、回滚和 390px 窄屏。均使用本地模拟模型，不使用真实 API Key；尚未用付费模型和人工标注任务验证泛化收益。
