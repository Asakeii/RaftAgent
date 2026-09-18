# 模型人民币成本配置

核查 SDK 0.3.267（package-lock.json 与本地 sdk.d.ts），参考：
- https://platform.claude.com/docs/en/agent-sdk/cost-tracking
- https://platform.claude.com/docs/en/agent-sdk/typescript

复用 SDK result.modelUsage 的 inputTokens、outputTokens、cacheReadInputTokens、cacheCreationInputTokens；不叠加 assistant usage 或已包含于 outputTokens 的 thinkingTokens。结果是快照，重复结果覆盖而非累加。

SDK Settings.modelPricing 原生支持 USD/百万 tokens，并影响 total_cost_usd 与美元预算；不能把人民币单价伪装成美元。因此仅在本地展示/评测层补充人民币 token 成本计算，保留原始 estimatedCostUsd。模型设置沿用本地 llm-settings.json 的原子持久化与校验。

人民币成本 = [(输入 + 缓存写入) × 输入价 + 输出 × 输出价 + 缓存命中 × (开启命中计价 ? 命中价 : 输入价)] / 1,000,000。

缓存开关仅控制计价，不保证或禁用服务商实际缓存。没有单独缓存写入字段，按输入价格计算。所有本轮模型用量采用同组价格（适合当前统一模型配置）；混合不同费率模型需要将来扩展按模型价格表。不包含工具/搜索单次调用收费。

运行开始记录价格快照；后续改价仅影响新运行，历史不重算。未配置价格、旧运行或 token 用量不完整不生成人民币总额，不假定免费。价格允许零；三个数值必须有限、非负且不超过 10 亿。清除配置保留 SDK 原始美元估算。
