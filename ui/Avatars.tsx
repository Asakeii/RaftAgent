/** Decorative identities; names are provided by the adjacent accessible text. */
export function AgentAvatar({ tone = 0 }: { tone?: number }) {
  return <span aria-hidden="true" className={`avatar agent-avatar tone-${tone % 4}`}><i /><i /></span>;
}
export function GroupAvatar({ tones }: { tones: number[] }) {
  return <span aria-hidden="true" className="group-avatar">{(tones.length ? tones.slice(0, 3) : [0, 1]).map((tone, i) => <AgentAvatar key={i} tone={tone} />)}{tones.length > 3 && <small>+{tones.length - 3}</small>}</span>;
}
