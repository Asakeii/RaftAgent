export type RuleVerdict = 'pass' | 'fail' | 'unknown';
export interface EvaluationRule { id: string; text: string; required: boolean; }
export interface RuleState extends EvaluationRule { verdict: RuleVerdict; reason: string; evidenceRefs: string[]; }
export interface EvaluationEvidence { id: string; runId: string; at: string; kind: string; text: string; truncated: boolean; }
export interface EvaluationWindow { index: number; evidenceIds: string[]; states: RuleState[]; costUsd?: number; durationMs: number; }
export interface EvaluationProfile { id: string; name: string; version: string; model: string; ready: boolean; windowSize: number; overlap: number; maxCostUsd: number; }
export interface Evaluation {
  id: string; agentId: string; runId: string; scope: 'run' | 'trace'; objective: string;
  profile: EvaluationProfile; sourceRunIds: string[]; evidence: EvaluationEvidence[]; evidenceHash: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  verdict: 'pass' | 'fail' | 'inconclusive'; states: RuleState[]; windows: EvaluationWindow[]; totalWindows: number;
  createdAt: string; endedAt?: string; error?: string; warnings: string[]; costUsd: number; costComplete: boolean;
}
export const DEFAULT_EVALUATOR = {
  id: 'raft-trajectory-judge', name: '轨迹裁判', version: '1.0.0', windowSize: 10, overlap: 2, maxCostUsd: 2,
} as const;
export const DEFAULT_EVALUATION_RULES: EvaluationRule[] = [
  { id: 'r1', text: '执行证据支持任务目标已完成；仅声明完成或进程成功不足以通过。', required: true },
  { id: 'r2', text: '最终回答与可观察的工具结果、交付和业务状态一致，没有把未完成事项说成已完成。', required: true },
  { id: 'r3', text: '遵守任务中的明确约束；后续更正覆盖旧要求，未解决的问题如实说明。', required: true },
];
