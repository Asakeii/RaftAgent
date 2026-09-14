export type AgentStatus = "idle" | "running" | "stopped" | "error";
export interface Agent { id: string; name: string; role: string; systemPrompt?: string; parentAgentId?: string; workspace: string; sessionId?: string; status: AgentStatus; error?: string; runs: number; }
export interface Room { id: string; name: string; members: string[]; version: number; }
export interface Message { id: string; channel: string; sender: string; text: string; at: string; mentions: string[]; }
export interface Receipt { messageId: string; agentId: string; read: boolean; arrival: number; }
export interface Draft { id: string; roomId: string; agentId: string; body: string; mentions: string[]; basedOn: number; status: "held" | "committed" | "discarded"; }
export interface Task { id: string; roomId: string; title: string; owner: string | null; status: "pending" | "working" | "reviewing" | "done"; version: number; evidence: string; }
export interface Activity { id: string; runId: string; agentId: string; channel: string; text: string; status: string; at: string; }
export interface Input { id: string; agentId: string; text: string; channel: string; kind: "direct" | "room" | "inbox" | "delegated"; replyToAgentId?: string; originRunId?: string; status: "pending" | "running" | "done" | "unknown"; }
export interface Run { id: string; agentId: string; inputId: string; status: "running" | "done" | "error" | "unknown"; at: string; }
export interface Audit { seq: number; type: string; text: string; at: string; }
export interface PublishedSkill { agentId: string; name: string; description: string; version: string; publishedAt: string; }
export interface AppState { agents: Agent[]; rooms: Room[]; messages: Message[]; receipts: Receipt[]; drafts: Draft[]; tasks: Task[]; activities: Activity[]; inputs: Input[]; runs: Run[]; notices: Record<string, number>; requests: Record<string, { fingerprint: string; result: unknown }>; publishedSkills?: PublishedSkill[]; events: Audit[]; seq: number; }
export interface Command { name: string; args: Record<string, unknown>; requestId?: string; }
export type Actor = { kind: "user" } | { kind: "agent"; agentId: string; runId: string; channel: string };
export interface Approval { id: string; agentId: string; tool: string; input: unknown; }
export interface ModelSettingsView { baseUrl: string; model: string; hasApiKey: boolean; source: "saved" | "environment"; }
export interface Snapshot { state: AppState; approvals: Approval[]; ready: boolean; model: string; dataDir: string; }
export const emptyState = (): AppState => ({ agents: [], rooms: [], messages: [], receipts: [], drafts: [], tasks: [], activities: [], inputs: [], runs: [], notices: {}, requests: {}, events: [], seq: 0 });
