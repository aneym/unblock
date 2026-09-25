import type { ReactNode } from 'react'
import type { Ask } from './deck'

type Name = 'key' | 'click' | 'decision' | 'question' | 'permission' | 'consent' | 'spend' | 'message'
  | 'waiting' | 'answered' | 'park' | 'draft' | 'sent' | 'detected' | 'lock' | 'diamond' | 'arrow'
  | 'fingerprint' | 'shield'
export function Icon({ name, size = 18 }: { name: Name; size?: number }) {
  const paths: Record<Name, ReactNode> = {
    key: <><circle cx="7" cy="8" r="4" /><path d="m10 11 9 9m-3-3 2-2m-5-1 2-2" /></>,
    click: <><path d="m5 3 1 14 3-3 3 6 3-2-3-6 5-.5zM4 1 2 0m8 0 1-2" /></>,
    decision: <><path d="M12 21V4m0 5H5l-2-2 2-2h7m0 1h7l2 2-2 2h-7" /></>,
    question: <><circle cx="12" cy="12" r="10" /><path d="M9 9a3 3 0 1 1 5 2l-2 2v1m0 3h.01" /></>,
    permission: <><path d="M12 2 4 5v6c0 5 3 8 8 11 5-3 8-6 8-11V5z" /><path d="M12 8v5m0 3h.01" /></>,
    arrow: <path d="M4 12h15m-6-6 6 6-6 6" />,
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
    fingerprint: <>
      <path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4" />
      <path d="M14 13.12c0 2.38 0 6.38-1 8.88" />
      <path d="M17.29 21.02c.12-.6.43-2.3.5-3.02" />
      <path d="M2 12a10 10 0 0 1 18-6" />
      <path d="M2 16h.01" />
      <path d="M21.8 16c.2-2 .131-5.354 0-6" />
      <path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2" />
      <path d="M8.65 22c.21-.66.45-1.32.57-2" />
      <path d="M9 6.8a6 6 0 0 1 9 5.2v2" />
    </>,
    shield: <path d="M12 2 4 5v6c0 5 3 8 8 11 5-3 8-6 8-11V5z" />,
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
