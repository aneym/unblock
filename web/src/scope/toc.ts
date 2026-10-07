import type { ScopeV2 } from '../../../src/scope-doc.js'

let observer: IntersectionObserver | undefined
let contents: HTMLElement | undefined
let stopResponsive: (() => void) | undefined
let stopScroll: (() => void) | undefined

export function renderContents(scope: ScopeV2, doc: HTMLElement, overview: boolean) {
  observer?.disconnect(); stopResponsive?.(); stopScroll?.()
  if (overview) { contents?.remove(); contents = undefined; document.body.classList.remove('has-contents'); return }
  document.body.classList.add('has-contents')
  if (!contents) {
    contents = document.createElement('nav')
    contents.className = 'scope-toc'
    contents.setAttribute('aria-label', 'Table of contents')
    doc.before(contents)
  }
  const wasOpen = contents.querySelector('details')?.open || false
  contents.replaceChildren()
  const label = document.createElement('div'); label.className = 'toc-label'; label.textContent = 'Contents'
  const disclosure = document.createElement('details'); disclosure.open = wasOpen
  const desktop = matchMedia('(min-width: 1200px)')
  const responsive = () => { disclosure.open = desktop.matches }
  desktop.addEventListener('change', responsive)
  stopResponsive = () => desktop.removeEventListener('change', responsive)
  if (desktop.matches) disclosure.open = true
  const summary = document.createElement('summary'); summary.textContent = 'Contents'
  const list = document.createElement('div'); list.className = 'toc-list'
  disclosure.append(summary, list); contents.append(label, disclosure)
  const sections = scope.doc.sections.filter(s => s.id !== 'title' && document.getElementById(s.id)?.querySelector('h2'))
  const links = new Map<string, HTMLAnchorElement>()
  const offset = () => (document.querySelector('.pc-bar')?.getBoundingClientRect().height || 0) + 24
  const mark = (id: string) => {
    for (const [section, link] of links) {
      if (section === id) link.setAttribute('aria-current', 'location')
      else link.removeAttribute('aria-current')
    }
  }
  for (const section of sections) {
    const link = document.createElement('a'); link.href = `#${encodeURIComponent(section.id)}`
    link.textContent = section.heading.replace(/\s*\{#[^}]+\}\s*$/, '')
    if (scope.threads.some(t => t.status === 'open' && t.anchor.section === section.id)) {
      const dot = document.createElement('span'); dot.className = 'toc-dot'; dot.setAttribute('aria-label', 'Open comments'); link.append(dot)
    }
    link.addEventListener('click', event => {
      event.preventDefault(); disclosure.open = desktop.matches
      const target = document.getElementById(section.id)
      if (!target) return
      history.replaceState(null, '', link.hash)
      window.scrollTo({ top: window.scrollY + target.getBoundingClientRect().top - offset(), behavior: 'smooth' })
      mark(section.id)
    })
    links.set(section.id, link); list.append(link)
  }
  const update = () => {
    let current = sections[0]?.id
    for (const section of sections) {
      if ((document.getElementById(section.id)?.getBoundingClientRect().top ?? Infinity) <= offset() + 3) current = section.id
    }
    if (current) mark(current)
  }
  window.addEventListener('scroll', update, { passive: true })
  stopScroll = () => window.removeEventListener('scroll', update)
  observer = new IntersectionObserver(update, { rootMargin: `-${offset()}px 0px -65% 0px`, threshold: [0, 1] })
  for (const section of sections) { const node = document.getElementById(section.id)?.querySelector('h2'); if (node) observer.observe(node) }
  // CSS displays the list independently of details on desktop.
  update()
}
