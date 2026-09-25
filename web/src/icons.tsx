import type { ReactNode } from 'react'
import type { Ask } from './deck'

type Name = 'decision' | 'blocker' | 'park' | 'draft' | 'sent' | 'detected' | 'lock' | 'diamond'
export function Icon({ name }: { name: Name }) {
  const paths: Record<Name, ReactNode> = {
    decision: <path d="m7 1 6 6-6 6-6-6z" />,
    diamond: <path d="m7 1 6 6-6 6-6-6z" />,
    blocker: <rect x="1.5" y="1.5" width="11" height="11" rx="1" />,
    park: <><circle cx="7" cy="7" r="5.5" /><path d="M5.5 4.5v5m3-5v5" /></>,
    draft: <><path d="m2 10 7.5-7.5 2 2L4 12H2zM8.5 3.5l2 2" /></>,
    sent: <path d="m2 7 3.5 3.5L12 3" />,
    detected: <circle cx="7" cy="7" r="5.5" strokeDasharray="2 2" />,
    lock: <><rect x="2" y="6" width="10" height="7" rx="1" /><path d="M4 6V4a3 3 0 0 1 6 0v2" /></>,
  }
  return (
    <svg
      aria-hidden="true"
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="state-icon"
    >
      {paths[name]}
    </svg>
  )
}
export function stateOf(ask: Ask, draft = false): { name: Name; label: string } {
  if (draft) return { name: 'draft', label: 'Draft' }
  if (ask.origin.detected) return { name: 'detected', label: 'Stalled' }
  if (ask.kind === 'park') return { name: 'park', label: 'Agent stopped' }
  return ask.purpose === 'decision'
    ? { name: 'decision', label: 'Decision' }
    : { name: 'blocker', label: 'To do' }
}
