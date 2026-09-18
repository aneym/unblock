import { Fragment, type ReactNode } from 'react'

const URL_RE = /(https?:\/\/[^\s<>()\[\]"']+[^\s<>()\[\]"'.,;:!?])/g

/**
 * Render plain text with bare http(s) URLs as links. Asks are authored as
 * plain strings (why, steps, labels, help, recommendations), so a URL in any
 * of them was landing as inert text; this keeps the text exactly as written
 * and only wraps the URL. Trailing punctuation stays outside the link.
 */
export function Linkify({ text }: { text: string | null | undefined }): ReactNode {
  if (!text) return null
  const parts = text.split(URL_RE)
  if (parts.length === 1) return text
  return parts.map((part, index) =>
    index % 2 === 1
      ? <a key={index} href={part} target="_blank" rel="noopener noreferrer" className="underline decoration-[var(--faint)] underline-offset-2 hover:decoration-[var(--ink)] break-all" onClick={(event) => event.stopPropagation()}>{part}</a>
      : <Fragment key={index}>{part}</Fragment>,
  )
}
