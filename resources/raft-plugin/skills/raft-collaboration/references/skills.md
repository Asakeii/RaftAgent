# 编写、发布和热加载 Skill

当功能值得复用时，将使用方法写进 Skill，实际执行由本地工具、脚本或 CLI 完成。Skill 源码和发布版本统一存于应用数据目录的 skills/sources 与 skills/releases。每个 Agent 按启用配置加载；发布自动为维护者启用，其他成员由用户在 Skills 配置中勾选。

在自己的工作目录创建一个草稿目录，例如：

```text
skill-drafts/count-lines/
  SKILL.md
  scripts/count.mjs
```

`SKILL.md` 示例：

```markdown
---
name: count-lines
description: 统计指定本地文本文件的行数，在用户需要文件行数时使用。
---

用 Bash 执行 `raftctl skill run --name raft-local:count-lines --script scripts/count.mjs -- <目标文件绝对路径>`。
宿主解析当前启用的发布版本，脚本在 Bash 沙箱中执行。
读取命令实际输出后报告行数；执行失败时如实报告。
```

使用 Write/Edit 编写和修改文件，调用本地工具实际验证脚本。脚本、引用及资产放在 `scripts/`、`references/`、`assets/`，不要复制无关文件或凭据。源码修改后需再次发布，已发布快照不会自动跟随草稿变化。

已发布脚本通过 `raftctl skill run --name 插件:名称 --script scripts/文件 -- 参数` 执行；支持 py/sh/js/mjs/cjs。`--` 后的参数原样交给脚本。脚本继承宿主注入的 RAFT_TRACE_ID、RAFT_RUN_ID、RAFT_SKILL_ID、RAFT_SKILL_VERSION，不生成或打印这些环境变量。相同 request-id 禁止重复启动脚本；超时或回执丢失先核验实际结果，不能换 ID 盲目重跑。输出包含脚本原始输出与末尾 JSON 回执，进程成功不代表业务成功。直接运行 python/node 的旧脚本不会自动产生 Skill 归属证据。

```bash
raftctl skill publish --source ./skill-drafts/count-lines --json
```

命令返回的 `data.status=published` 表示已保存。**同时满足 `data.active=true`、`data.refresh.status=loaded`，且 `data.refresh.skills` 包含返回的 `data.skill`，才表示该版本当前有效、当前 Query 已刷新。** 然后用原生 Skill 工具调用 `raft-local:count-lines`，可以继续本轮任务，不必等下一轮。工具输出只是发布和加载结果，不是脚本执行成功证明。

`source` 相对路径以当前 Agent 的工作目录为基准，不受某次 Bash 中的 `cd` 影响；也可以提供该工作目录内的绝对路径。

刷新失败或超时时，发布仍保留；使用以下命令重试刷新：

```bash
raftctl skill reload --json
raftctl skill list --json
```

`list` 返回当前成员已发布的名称、描述、版本和发布目录；不代表模型已执行这些 Skills。运行内用 SDK 原生 reloadSkills 刷新，下一轮启动时自动恢复发布目录并继续使用同一 SDK 会话。

更新：修改草稿后再次 publish，CLI 为本次新操作自动分配 requestId；宿主将副本存入共享源码目录并发布新版本。也可由用户直接修改总目录中的源码，再在 Skills 面板点击“发布源码修改”。Agent 只能更新自己维护的 Skill，不能覆盖其他维护者的同名 Skill。重试同一次发布必须复用原 request-id；即使草稿后来改变，也只返回原发布凭据，不会偷换成新内容。原版本已被替换或移除时，重试可能返回 `active=false`。`raftctl request status --id ORIGINAL_ID` 查询持久发布结果，不代表当前 Query 已加载。

移除：

```bash
raftctl skill remove --name count-lines --json
```

检查 `data.refresh.status=loaded` 且列表不再包含此 Skill。移除仅停用当前 Agent 的配置，保留共享库及其他成员的启用项。停用只影响后续发现与加载，不能抹去已进入上下文的说明或终止已启动命令；历史发布文件保留供核验。不能用此命令移除内置协作 Skill。

当前发布格式：

- `name`、`description` 必填，可选 `argument-hint`，正文非空。name 使用小写字母、数字和连字符，最长 64 字符。
- 其余 frontmatter 字段暂不开放，尤其不能声明 allowed-tools、hooks、context 或 agent；权限继续沿用应用规则。内联 shell 展开 `!` 加反引号不支持，通过 Bash 显式执行。
- 每个 Skill 最多 128 个文件、2 MB、8 层目录；每个 Agent 最多启用 34 个 Skills（包含内置能力）。
- 来源必须在当前工作目录内，包内不接受符号链接、隐藏配置、MCP 或插件清单。发布只复制 Skill 与必要资源。凭证与个人邮箱配置仍留在各自工作目录，不放入共享 Skill。
- 发布失败时修正草稿，不修改应用源码、SDK 设置或托管插件目录来绕过流程。

## 共享目录和启用配置

`raftctl skill catalog --json` 查看共享库，`skill list` 查看自己启用的条目。路径以返回值为准。用户在成员对话上方的 Skills 面板配置启用项；其他 Agent 不会因为有人发布了新 Skill 就自动加载。配置和其他维护者发布的新版本在下一轮或显式 `skill reload` 后生效。Skills 名单控制发现与加载，不替代文件访问权限。
