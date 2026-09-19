export interface EvolutionFile { path: string; text: string; }
export type FileCheck = { path: string; kind: 'exists' | 'text' | 'json'; expected?: string };
export interface EvolutionCase { id: string; name: string; prompt: string; fixtures: EvolutionFile[]; checks: FileCheck[]; }
export interface CheckResult { path: string; kind: string; passed: boolean; reason: string; }
export interface EvolutionTrial {
  caseId: string; repeat: number; variant: 'baseline' | 'candidate'; status: 'completed' | 'error'; passed: boolean;
  checks: CheckResult[]; artifacts: EvolutionFile[]; transcript: string[]; costUsd: number; durationMs: number; error?: string;
}
export type EvolutionStatus = 'generating' | 'ready' | 'testing' | 'eligible' | 'blocked' | 'promoting' | 'promoted' | 'rolling_back' | 'rolled_back' | 'cancelled' | 'failed' | 'interrupted';
export interface Evolution {
  id: string; evaluationId: string; agentId: string; skillId: string; skillName: string; baselineVersion: string;
  candidateVersion?: string; baseline: EvolutionFile[]; candidate: EvolutionFile[];
  cases: EvolutionCase[]; caseHash: string; repeats: number; profile: 'text-files-v1'; model: string; generatorModel: string; baseUrl: string;
  status: EvolutionStatus; summary: string; applicability: string; trials: EvolutionTrial[];
  gate: { passed: boolean; reasons: string[] }; costUsd: number; costComplete: boolean;
  createdAt: string; updatedAt: string; error?: string;
}
export const EVOLUTION_LIMITS = { cases: 8, repeats: 2, maxCostUsd: 4, timeoutMs: 600_000 } as const;
