import type { ModelUsage } from '@anthropic-ai/claude-agent-sdk';
import type { ModelPricing } from './contracts.js';

/** SDK modelUsage is a result snapshot: never add assistant usage or thinking tokens again. */
export function calculateCostCny(usage: Record<string, ModelUsage>, pricing: ModelPricing): number | undefined {
  const rows = Object.values(usage);
  if (!rows.length) return undefined;
  let total = 0;
  for (const row of rows) {
    const tokens = [row.inputTokens, row.outputTokens, row.cacheReadInputTokens, row.cacheCreationInputTokens];
    if (tokens.some(n => typeof n !== 'number' || !Number.isFinite(n) || n < 0)) return undefined;
    total += ((row.inputTokens + row.cacheCreationInputTokens) * pricing.input
      + row.outputTokens * pricing.output
      + row.cacheReadInputTokens * (pricing.cacheHitEnabled ? pricing.cacheHit : pricing.input)) / 1_000_000;
  }
  return Number.isFinite(total) ? total : undefined;
}
