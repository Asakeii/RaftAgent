import type { ModelPricing } from "./contracts.js";
export interface HistoryBlock { kind: string; text: string; toolId?: string; name?: string; error?: boolean; }
export interface HistoryMessage { id: string; role: 'input' | 'assistant' | 'tool' | 'system'; turn: number; at?: string; model?: string; runId?: string; blocks: HistoryBlock[]; }
export interface HistoryPage { sessionId: string | null; sessions: string[]; messages: HistoryMessage[]; nextBefore: string | null; total: number; }
export interface TraceRun {
  id: string; traceId: string; agentId: string; inputId: string; parentRunId?: string; parentAgentId?: string;
  sessionId?: string; contextVersion?: number; channel: string; kind: string; prompt: string; model: string; baseUrl: string;
  startedAt: string; endedAt?: string; status: 'running' | 'done' | 'error' | 'stopped' | 'unknown'; phase: string;
  durationMs?: number; apiDurationMs?: number; turns?: number; usage?: unknown; estimatedCostUsd?: number; costCny?: number | undefined; pricing?: ModelPricing; error?: string;
}
export interface TraceEvent { seq: number; traceId?: string; runId: string; at: string; kind: string; level: 'info' | 'warn' | 'error'; summary: string; detail?: unknown; toolId?: string; durationMs?: number; }
export interface TraceList { legacyRuns?: number; runs: TraceRun[]; nextBefore: string | null; pending: number; agentStatus: string; ready: boolean; warning?: string; }
export interface SkillUsage {
  skillId: string; skillVersion: string; skillName: string;
  loaded: number; loadFailed: number; serviceReturned: number; serviceFailed: number; replayed: number;
  processSucceeded: number; processFailed: number; incomplete: number;
  state: 'loaded_only' | 'execution_observed' | 'unknown';
}
export interface TraceDetail { run: TraceRun; events: TraceEvent[]; nextAfter: number | null; related: { id: string; agentId: string; channel?: string; status: string }[]; skillUsage?: SkillUsage[]; warning?: string; }
