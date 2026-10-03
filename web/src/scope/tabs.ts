function select(group: HTMLElement, index: number, focus = false, scroll = true) {
  const tabs = [...group.querySelectorAll<HTMLButtonElement>(':scope > [role="tablist"] > [role="tab"]')]
  const panels = [...group.querySelectorAll<HTMLElement>(':scope > [role="tabpanel"]')]
  if (!tabs[index]) return
  tabs.forEach((tab, i) => { tab.setAttribute('aria-selected', String(i === index)); tab.tabIndex = i === index ? 0 : -1; panels[i].hidden = i !== index })
  const stage = panels[index].querySelector<HTMLElement>('.demo-stage')
  // The existing demo observer mounts visible stages and registers their player messages.
  if (stage) stage.dataset.src = stage.dataset.tabSrc
  if (focus) tabs[index].focus()
  if (scroll && typeof tabs[index].scrollIntoView === 'function') tabs[index].scrollIntoView({ block: 'nearest', inline: 'nearest' })
  group.dispatchEvent(new CustomEvent('scope-tab-change', { bubbles: true }))
}
function panelForCard(card: HTMLElement): HTMLElement | null {
  const id = card.dataset.t
  if (!id) return null
  const mark = document.querySelector<HTMLElement>(`mark[data-t="${CSS.escape(id)}"]`)
  return mark?.closest<HTMLElement>('[role="tabpanel"]') || null
}

function refresh() {
  let hintsChanged = false
  document.querySelectorAll<HTMLElement>('.scope-tabs').forEach(group => {
    if (group.dataset.tabsReady) return
    group.dataset.tabsReady = 'true'
    const section = group.closest('section')?.id || 'doc'
    const panels = [...group.querySelectorAll<HTMLElement>(':scope > [role="tabpanel"]')]
    group.querySelectorAll<HTMLElement>(':scope > [role="tablist"] > [role="tab"]').forEach((tab, index) => {
      tab.id = `${section}-${tab.id}`; panels[index].id = `${section}-${panels[index].id}`
      tab.setAttribute('aria-controls', panels[index].id); panels[index].setAttribute('aria-labelledby', tab.id)
    })
    select(group, 0, false, false)
    group.addEventListener('click', event => {
      const tab = (event.target as Element).closest('[role="tab"]')
      if (tab) select(group, [...group.querySelectorAll('[role="tab"]')].indexOf(tab))
    })
    group.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key) || !(event.target as Element).matches('[role="tab"]')) return
      event.preventDefault()
      const tabs = [...group.querySelectorAll('[role="tab"]')], index = tabs.indexOf(event.target as Element)
      select(group, (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length, true)
    })
  })
  document.querySelectorAll<HTMLElement>('.card[data-t]').forEach(card => {
    const panel = panelForCard(card), hint = card.querySelector<HTMLElement>('.tab-thread-hint')
    if (!panel?.hidden) { if (hint) { hint.remove(); hintsChanged = true }; return }
    const text = `In tab: ${panel.dataset.tabLabel}`
    if (hint?.textContent === text) return
    hint?.remove()
    const button = document.createElement('button'); button.type = 'button'; button.className = 'tab-thread-hint'; button.textContent = text
    button.addEventListener('click', () => {
      const group = panel.closest<HTMLElement>('.scope-tabs')!
      select(group, [...group.querySelectorAll(':scope > [role="tabpanel"]')].indexOf(panel))
    })
    card.append(button); hintsChanged = true
  })
  if (hintsChanged) document.dispatchEvent(new CustomEvent('scope-tab-change'))
}
if (typeof document !== 'undefined' && typeof MutationObserver !== 'undefined') {
  document.addEventListener('click', event => {
    const card = (event.target as Element).closest<HTMLElement>('.card[data-t]')
    const panel = card && panelForCard(card)
    if (!panel?.hidden) return
    const group = panel.closest<HTMLElement>('.scope-tabs')!
    select(group, [...group.querySelectorAll(':scope > [role="tabpanel"]')].indexOf(panel))
  }, true)
  let queued = false
  new MutationObserver(() => {
    if (queued) return
    queued = true; queueMicrotask(() => { queued = false; refresh() })
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] })
  document.addEventListener('scope-thread-focus', event => {
    const id = (event as CustomEvent<string>).detail
    const card = document.querySelector<HTMLElement>(`.card[data-t="${CSS.escape(id)}"]`)
    const panel = card && panelForCard(card)
    if (!panel?.hidden) return
    const group = panel.closest<HTMLElement>('.scope-tabs')!
    select(group, [...group.querySelectorAll(':scope > [role="tabpanel"]')].indexOf(panel))
  })
}
