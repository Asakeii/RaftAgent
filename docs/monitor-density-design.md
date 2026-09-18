# 紧凑监测界面

参考用户提供的轨迹查看器，将顶部统计卡片压缩为状态栏，运行与事件显示为紧凑行，事件时间轴与右侧详情面板共享选中状态。概览和执行日志复用 `TraceExplorer`；支持已加载事件搜索、摘要与原始事件查看。窄屏下列表和详情上下排列。

## SDK 核验与边界

实现前查阅 https://platform.claude.com/docs/en/agent-sdk/typescript ，核验本地及锁定依赖 `@anthropic-ai/claude-agent-sdk` 0.3.267。继续使用现有服务对 SDKMessage、SDKResultMessage 的采集和已有 TraceDetail / TraceEvent 接口；本次不新增 Agent 执行逻辑。SDK 提供执行数据，业务前端负责布局和交互。

时间轴根据事件时间定位；仅有 durationMs 的事件显示记录的耗时区间，否则显示时刻标记，不推断模型持续时间。工具耗时可能包含授权等待。搜索范围为已加载事件，缺失耗时显示“未记录”。
