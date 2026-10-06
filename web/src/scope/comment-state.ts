// What the chip under Alex's comment reads. Pure: no DOM, no fetches; page.ts renders the result.
import type { DocSection } from '../../../src/scope-doc.js'

export type CommentChip = 'Answered' | 'Sent' | 'Sending…' | 'Retrying' | 'Not sent' | 'No lane pane' | 'Seen 👀' | ''

type ChipSection = DocSection & { updated_at?: string }

export function commentState({ note, thread, section, seen }: {
  note?: { delivery?: string | null; at?: string; event?: string; text?: string; delivered_at?: string | null } | null
  thread?: {
    status?: string
    delivery?: string
    resolution?: { confirmed_at?: string | null } | null
    messages?: { from: string; at: string; pending?: boolean; handoff?: boolean }[]
  } | null
  section?: ChipSection | null
  seen?: boolean
}): CommentChip {
  // A Rails copy with no note and no delivery field says nothing it can't back.
  if (!note && !['in_doc', 'with_lane', 'queued'].includes(thread?.delivery ?? '')) return seen ? 'Seen 👀' : ''
  const messages = thread?.messages ?? []
  const lastAlex = messages.reduce((index, message, i) => (message.from === 'alex' ? i : index), -1)
  const real = (message: { from: string; pending?: boolean; handoff?: boolean }) => message.from === 'agent' && !message.pending && !message.handoff
  // A real reply to his comment settles it, whatever the delivery field says; a pending or hand-off responder line
  // is not an answer. For a comment, order decides, not time: the responder stamps its message like his. A take,
  // park, resolve or a bare reopen adds no message of his, so only a reply after that note's own time counts.
  const action = ['take', 'own', 'resolve', 'park', 'delete'].includes(note?.event ?? '') || (note?.event === 'reopen' && !note.text)
  const replied = action
    ? !!note?.at && messages.some((message) => real(message) && message.at > note.at!)
    : lastAlex >= 0 && messages.slice(lastAlex + 1).some(real)
  if (replied || (thread?.status === 'resolved' && thread.resolution?.confirmed_at)) return 'Answered'
  if (note) {
    // The lane may answer by editing the section instead; only an edit after delivery counts.
    if (note.delivery === 'delivered' && note.delivered_at && (section?.updated_at ?? '') > note.delivered_at) return 'Answered'
    if (note.delivery === 'retrying') return 'Retrying'
    if (note.delivery === 'failed') return 'Not sent'
    if (note.delivery === 'no_pane') return 'No lane pane'
    if (seen) return 'Seen 👀'
    if (note.delivery === 'delivered' || note.delivery === 'answerer') return 'Sent'
    return 'Sending…'
  }
  if (lastAlex >= 0 && (section?.updated_at ?? '') > messages[lastAlex].at) return 'Answered'
  if (thread?.delivery === 'in_doc') return 'Answered'
  if (seen) return 'Seen 👀'
  return thread?.delivery === 'queued' ? 'Sending…' : 'Sent'
}
