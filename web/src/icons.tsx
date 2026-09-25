import type { ReactNode } from 'react'
import type { Ask } from './deck'

type Name = 'key' | 'click' | 'decision' | 'consent' | 'spend' | 'message'
  | 'waiting' | 'answered' | 'park' | 'draft' | 'sent' | 'detected' | 'lock' | 'diamond'
export function Icon({ name, size = 18 }: { name: Name; size?: number }) {
  const paths: Record<Name, ReactNode> = {
    key: <><circle cx="7" cy="8" r="4" /><path d="m10 11 9 9m-3-3 2-2m-5-1 2-2" /></>,
    click: <><path d="m5 3 1 14 3-3 3 6 3-2-3-6 5-.5zM4 1 2 0m8 0 1-2" /></>,
    decision: <><path d="M12 21V4m0 5H5l-2-2 2-2h7m0 1h7l2 2-2 2h-7" /></>,
    consent: <><path d="M12 2 4 5v6c0 5 3 8 8 11 5-3 8-6 8-11V5z" /><path d="m8 12 3 3 5-6" /></>,
    spend: <><rect x="2" y="4" width="20" height="16" rx="2" /><path d="M2 9h20m-16 7h4" /></>,
    message: <path d="M21 15a3 3 0 0 1-3 3H9l-5 4v-4a3 3 0 0 1-2-3V5a3 3 0 0 1 3-3h13a3 3 0 0 1 3 3z" />,
    waiting: <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" />,
    answered: <path d="m4 12 5 5L20 6" />,
    park: <><circle cx="12" cy="12" r="10" /><path d="M9 8v8m6-8v8" /></>,
    draft: <path d="m3 17 12-12 4 4L7 21H3zm11-11 4 4" />,
    sent: <path d="m4 12 5 5L20 6" />,
    detected: <circle cx="12" cy="12" r="10" strokeDasharray="2 2" />,
    lock: <><rect x="4" y="10" width="16" height="12" rx="2" /><path d="M7 10V7a5 5 0 0 1 10 0v3" /></>,
    diamond: <path d="m12 2 10 10-10 10L2 12z" />,
  }
  return (
    <svg
      aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
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
    : { name: 'click', label: 'To do' }
}
