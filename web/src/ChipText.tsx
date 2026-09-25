import { Fragment, type ReactNode } from 'react'
import { urlChip } from './links'

const URL_RE = /(https?:\/\/[^\s<>()\[\]"']+[^\s<>()\[\]"'.,;:!?])/g
const HAS_URL = /https?:\/\/[^\s<>()\[\]"']+/i

function shortenPlainUrls(text: string) {
  if (!HAS_URL.test(text)) return text
  return text.replace(URL_RE, (url) => urlChip(url).text)
}

export function Chip({ url, className = '' }: { url: string; className?: string }) {
  const chip = urlChip(url)
  return (
    <a className={`url-chip ${className}`} href={chip.href} title={url} target="_blank" rel="noopener noreferrer">
      {chip.text}
    </a>
  )
}

export function ChipText({ text }: { text: string | null | undefined }): ReactNode {
  if (!text) return null
  return text.split(URL_RE).map((part, index) => index % 2
    ? <Chip key={index} url={part} />
    : <Fragment key={index}>{part}</Fragment>)
}

export function PlainText({ text }: { text: string }) {
  return <>{shortenPlainUrls(text)}</>
}
