import { applyHostContext } from '../embed.js';

export const VERSION = 'page-chrome@1.0';
const ID = /^[a-z][a-z0-9_-]{0,39}$/;
const KEYS = /^(Meta\+|Control\+|Shift\+|Alt\+){0,3}[A-Za-z0-9,./\[\]]$/;
const KINDS = new Set(['read', 'move', 'change', 'send', 'phone', 'screen-only']);
const plain = (value) => value !== null && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

/** Validate the complete rails/page v1 wire description, including its references. */
export function validatePageMessage(params) {
  const errors = [];
  const fail = (field, reason) => errors.push(`${field}: ${reason}`);
  const only = (obj, fields, path) => Object.keys(obj).forEach((key) => { if (!fields.includes(key)) fail(`${path}${key}`, 'unknown field'); });
  const label = (value, path) => { if (typeof value !== 'string' || Array.from(value).length < 1 || Array.from(value).length > 80 || !/\S/.test(value)) fail(path, 'expected a nonblank label of 1–80 code points'); };
  const id = (value, path) => { if (typeof value !== 'string' || !ID.test(value)) fail(path, 'invalid action id'); };
  if (!plain(params)) return { ok: false, errors: ['params: expected a plain object'] };
  only(params, ['v', 'title', 'back', 'primary', 'menu', 'actions'], '');
  if (params.v !== 1) fail('v', 'expected 1');
  label(params.title, 'title');
  if ('back' in params) {
    if (!plain(params.back)) fail('back', 'expected a plain object');
    else {
      only(params.back, ['label', 'route'], 'back.');
      label(params.back.label, 'back.label');
      const route = params.back.route;
      if (typeof route !== 'string' || Array.from(route).length > 300 || !/^\/(?!\/)[^\\\s]*$/.test(route)) fail('back.route', 'expected a local route of at most 300 characters');
    }
  }
  const ids = new Set();
  if (!Array.isArray(params.actions)) fail('actions', 'expected an array');
  else {
    if (params.actions.length > 12) fail('actions', 'at most 12 actions');
    params.actions.forEach((action, i) => {
      const path = `actions[${i}]`;
      if (!plain(action)) { fail(path, 'expected a plain object'); return; }
      only(action, ['id', 'label', 'kind', 'keys'], `${path}.`);
      id(action.id, `${path}.id`);
      if (ids.has(action.id)) fail(`${path}.id`, 'duplicate action id');
      ids.add(action.id);
      label(action.label, `${path}.label`);
      if (!KINDS.has(action.kind)) fail(`${path}.kind`, 'unknown action kind');
      if ('keys' in action && (typeof action.keys !== 'string' || !KEYS.test(action.keys))) fail(`${path}.keys`, 'invalid shortcut');
    });
  }
  if ('primary' in params) {
    id(params.primary, 'primary');
    if (!ids.has(params.primary)) fail('primary', 'must name a declared action');
  }
  if ('menu' in params) {
    if (!Array.isArray(params.menu)) fail('menu', 'expected an array');
    else {
      if (params.menu.length > 8) fail('menu', 'at most 8 entries');
      const seen = new Set();
      params.menu.forEach((value, i) => {
        id(value, `menu[${i}]`);
        if (seen.has(value)) fail(`menu[${i}]`, 'duplicate menu id');
        if (!ids.has(value)) fail(`menu[${i}]`, 'must name a declared action');
        seen.add(value);
      });
    }
  }
  return { ok: errors.length === 0, errors };
}

export function pageMessage(spec) {
  const actions = (spec.actions ?? []).map(({ id, label, kind, keys }) => ({ id, label, kind, ...(keys !== undefined ? { keys } : {}) }));
  const menu = (spec.actions ?? []).filter((action) => action.placement === 'menu').map((action) => action.id);
  return { v: 1, title: spec.title, ...(spec.back !== undefined ? { back: { label: spec.back.label, route: spec.back.route } } : {}), ...(spec.primary !== undefined ? { primary: spec.primary } : {}), ...(menu.length ? { menu } : {}), actions };
}

export function statusLine(updatedAt, staleAfterMs, now = Date.now()) {
  if (updatedAt === undefined || updatedAt === null || !Number.isFinite(staleAfterMs) || staleAfterMs <= 0) return '';
  const stamp = updatedAt instanceof Date ? updatedAt.getTime() : typeof updatedAt === 'number' ? updatedAt : typeof updatedAt === 'string' ? Date.parse(updatedAt) : NaN;
  const age = now - stamp;
  if (!Number.isFinite(age) || age <= staleAfterMs || age < 0) return '';
  const [unit, duration] = age < 3600_000 ? ['minute', 60_000] : age < 86400_000 ? ['hour', 3600_000] : ['day', 86400_000];
  const count = Math.max(1, Math.floor(age / duration));
  return `Updated ${count} ${unit}${count === 1 ? '' : 's'} ago`;
}

let sequence = 0;
export function mountPage(root, initialSpec) {
  const doc = root.ownerDocument;
  const win = doc.defaultView;
  let spec;
  const validate = (next) => {
    let message;
    try { message = pageMessage(next); } catch { throw new TypeError('actions/back: invalid page spec'); }
    const result = validatePageMessage(message);
    if (!result.ok) throw new TypeError(result.errors.join('\n'));
    return Object.freeze({ ...next });
  };
  spec = validate(initialSpec);
  let hostOrigin;
  try {
    const origin = new URL(doc.referrer).origin;
    if (origin === win.location.origin || origin === 'https://app.rails.so' || /^https:\/\/[a-z0-9-]+\.rails\.so$/.test(origin) || spec.hostOrigins?.includes(origin)) hostOrigin = origin;
  } catch { /* A missing or invalid referrer cannot identify a trusted host. */ }
  const framed = win.parent !== win && Boolean(hostOrigin);
  const previousFlag = doc.documentElement.dataset.pcFramed;
  if (framed) doc.documentElement.dataset.pcFramed = 'true';
  let bar, head, menu, more, title, status;
  let destroyed = false;
  let announced = false;
  let handshakeDone = !(framed && plain(spec.initialize));
  let initId, initTimer, frameId;
  let scrolled;
  const post = (message) => { if (framed && !destroyed) win.parent.postMessage({ jsonrpc: '2.0', ...message }, hostOrigin); };
  const el = (tag, cls, text) => {
    const node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (cls, text, callback) => {
    const node = el('button', cls, text);
    node.type = 'button';
    node.addEventListener('click', callback);
    return node;
  };
  const navigate = (route) => spec.onNavigate ? spec.onNavigate(route) : win.location.assign(route);
  const closeMenu = (focus = false) => {
    menu?.remove(); menu = undefined;
    more?.setAttribute('aria-expanded', 'false');
    if (focus) more?.focus();
  };
  const toggleMenu = () => {
    if (menu) { closeMenu(); return; }
    menu = el('div', 'pc-menu menu');
    menu.setAttribute('role', 'menu');
    const item = (label, keys, callback) => {
      const node = button('pc-menu-item menu-item', label, () => { closeMenu(true); callback(); });
      node.setAttribute('role', 'menuitem');
      if (keys) node.append(el('kbd', '', keys));
      menu.append(node);
    };
    item('Open in new tab', '⌘⇧O', () => win.open(win.location.href, '_blank', 'noopener'));
    item('Copy link', '⌘L', () => { try { Promise.resolve(win.navigator.clipboard?.writeText(win.location.href)).catch(() => {}); } catch { /* Clipboard access may be unavailable. */ } });
    for (const action of spec.actions ?? []) if (action.placement === 'menu') item(action.label, action.keys, () => action.run({}));
    if (spec.settings) item(spec.settings.label, undefined, () => navigate(spec.settings.route));
    bar.append(menu);
    more.setAttribute('aria-expanded', 'true');
  };
  const refreshStatus = () => {
    status?.remove(); status = undefined;
    const text = statusLine(spec.updatedAt, spec.staleAfterMs);
    if (text) {
      status = el('span', 'pc-status', text);
      status.append(button('pc-refresh btn', 'Refresh', () => spec.onRefresh?.()));
      head.append(status);
    }
  };
  const measure = () => {
    frameId = undefined;
    if (destroyed) return;
    const next = title.getBoundingClientRect().bottom <= (framed ? 0 : 52);
    if (!framed) bar.dataset.scrolled = String(next);
    else if (announced && next !== scrolled) post({ method: 'rails/scrolled', params: { scrolled: next } });
    if (!framed || announced) scrolled = next;
  };
  const scheduleMeasure = () => { if (frameId === undefined) frameId = win.requestAnimationFrame(measure); };
  const render = () => {
    closeMenu(); bar?.remove(); head?.remove();
    if (!framed) {
      bar = el('header', 'pc-bar');
      bar.dataset.scrolled = 'false';
      if (spec.back) bar.append(button('pc-back frame-btn', `‹ ${spec.back.label}`, () => navigate(spec.back.route)));
      bar.append(el('span', 'pc-bar-title', spec.title));
      const primary = spec.actions?.find((action) => action.id === spec.primary);
      if (primary) bar.append(button('pc-bar-primary btn btn--primary', primary.label, () => primary.run({})));
      bar.append(el('span', 'pc-spacer'));
      more = button('pc-more frame-btn', '⋯', toggleMenu);
      more.setAttribute('aria-label', 'More');
      more.setAttribute('aria-haspopup', 'menu');
      more.setAttribute('aria-expanded', 'false');
      const chat = button('pc-chat frame-btn', undefined, () => spec.chat?.onToggle ? spec.chat.onToggle() : root.dispatchEvent(new win.CustomEvent('page-chrome:chat', { bubbles: true })));
      chat.setAttribute('aria-label', 'Chat');
      chat.setAttribute('aria-pressed', String(Boolean(spec.chat?.open)));
      const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
      const path = doc.createElementNS(svg.namespaceURI, 'path');
      path.setAttribute('d', 'M4 4h16v12H9l-5 4z');
      path.setAttribute('fill', 'none'); path.setAttribute('stroke', 'currentColor');
      svg.append(path); chat.append(svg); bar.append(more, chat);
    }
    head = el('div', 'pc-head');
    const row = el('div', 'pc-head-row');
    title = el('h1', 'pc-title type-large-title', spec.title);
    const actions = el('div', 'pc-head-actions');
    for (const action of spec.actions ?? []) if (action.placement !== 'menu') actions.append(button(`pc-action btn${action.id === spec.primary ? ' btn--primary' : ''}`, action.label, () => action.run({})));
    row.append(title, actions);
    head.append(row, el('p', 'pc-description', spec.description ?? ''));
    if (framed) root.prepend(head); else root.prepend(bar, head);
    refreshStatus(); scheduleMeasure();
  };
  const announce = () => {
    if (!framed || !handshakeDone || destroyed) return;
    post({ method: 'rails/page', params: pageMessage(spec) });
    post({ method: 'ui/update-model-context', params: { ...(spec.app !== undefined ? { app: spec.app } : {}), route: win.location.pathname + win.location.search, title: spec.title } });
    announced = true; scheduleMeasure();
  };
  const finishInit = (context) => {
    if (handshakeDone || destroyed) return;
    win.clearTimeout(initTimer);
    if (plain(context)) applyHostContext(context, doc.documentElement);
    handshakeDone = true; announce();
  };
  const onMessage = async (event) => {
    if (!framed || destroyed || event.source !== win.parent || event.origin !== hostOrigin) return;
    const data = event.data;
    if (!plain(data) || data.jsonrpc !== '2.0') return;
    if (!handshakeDone && data.id === initId && !data.method) { finishInit(data.result?.hostContext); return; }
    if (!handshakeDone || data.method !== 'rails/action' || !(typeof data.id === 'string' || typeof data.id === 'number')) return;
    const params = data.params;
    if (!plain(params) || typeof params.action !== 'string' || !ID.test(params.action) || !['run', 'preview'].includes(params.phase) || (params.args !== undefined && !plain(params.args)) || Object.keys(params).some((key) => !['action', 'phase', 'args'].includes(key))) {
      post({ id: data.id, error: { code: -32602, message: 'Invalid params' } }); return;
    }
    const action = spec.actions?.find((entry) => entry.id === params.action);
    if (!action) { post({ id: data.id, result: { ok: false, speech: 'That action is not on this page.' } }); return; }
    let result;
    try {
      const value = params.phase === 'run' ? await action.run(params.args ?? {}) : action.preview ? await action.preview(params.args) : undefined;
      result = value && typeof value === 'object' && typeof value.ok === 'boolean' && typeof value.speech === 'string' ? value : { ok: true, speech: action.label };
    } catch { result = { ok: false, speech: `${action.label} didn't work.` }; }
    post({ id: data.id, result });
  };
  const onKey = (event) => { if (event.key === 'Escape' && menu) { event.preventDefault(); closeMenu(true); } };
  const onOutside = (event) => { if (menu && !menu.contains(event.target) && !more.contains(event.target)) closeMenu(true); };
  win.addEventListener('message', onMessage);
  win.addEventListener('scroll', scheduleMeasure, { passive: true });
  win.addEventListener('resize', scheduleMeasure, { passive: true });
  doc.addEventListener('keydown', onKey);
  doc.addEventListener('click', onOutside);
  render();
  const statusTimer = win.setInterval(refreshStatus, 60_000);
  if (!handshakeDone) {
    initId = `pc-init-${++sequence}`;
    const { app, version, search } = spec.initialize;
    post({ id: initId, method: 'ui/initialize', params: { app, ...(version !== undefined ? { version } : {}), title: spec.title, ...(search !== undefined ? { search } : {}) } });
    initTimer = win.setTimeout(() => finishInit(), 1500);
  } else announce();
  return {
    framed, root,
    get spec() { return spec; },
    update(patch) { if (destroyed) return; spec = validate({ ...spec, ...patch }); render(); if (announced) announce(); },
    announce,
    destroy() {
      if (destroyed) return;
      destroyed = true; closeMenu(); bar?.remove(); head.remove();
      win.clearInterval(statusTimer); win.clearTimeout(initTimer);
      if (frameId !== undefined) win.cancelAnimationFrame(frameId);
      win.removeEventListener('message', onMessage); win.removeEventListener('scroll', scheduleMeasure); win.removeEventListener('resize', scheduleMeasure);
      doc.removeEventListener('keydown', onKey); doc.removeEventListener('click', onOutside);
      if (framed) { if (previousFlag === undefined) delete doc.documentElement.dataset.pcFramed; else doc.documentElement.dataset.pcFramed = previousFlag; }
    },
  };
}

export function commentsHeader(root, opts) {
  let state = { ...opts };
  const doc = root.ownerDocument;
  const render = () => {
    root.replaceChildren();
    for (const text of [`${state.open} open`, `${state.index} of ${state.total}`]) { const span = doc.createElement('span'); span.textContent = text; root.append(span); }
    for (const [name, text, callback] of [['Previous comment', '‹', 'onPrev'], ['Next comment', '›', 'onNext']]) {
      const button = doc.createElement('button'); button.type = 'button'; button.className = 'pc-comment-step frame-btn'; button.textContent = text; button.setAttribute('aria-label', name); button.addEventListener('click', () => state[callback]?.()); root.append(button);
    }
    const label = doc.createElement('label');
    const input = doc.createElement('input'); input.type = 'checkbox'; input.checked = Boolean(state.showResolved); input.addEventListener('change', () => state.onShowResolved?.(input.checked));
    label.append(input, ' Show resolved'); root.append(label);
  };
  root.classList.add('pc-comments'); render();
  return { update(patch) { state = { ...state, ...patch }; render(); }, destroy() { root.replaceChildren(); root.classList.remove('pc-comments'); } };
}

export function pageSuite(handle, { now = Date.now() } = {}) {
  const failures = [];
  const { root, spec, framed } = handle;
  const doc = root.ownerDocument;
  const bars = root.querySelectorAll('.pc-bar');
  if (framed ? bars.length !== 0 : bars.length !== 1) failures.push(framed ? 'A framed page must not draw a bar.' : 'A standalone page must draw exactly one bar.');
  if (!framed && bars.length) {
    const bar = bars[0];
    if (bar.getBoundingClientRect().height !== 52) failures.push('The page bar must be 52 pixels high.');
    if (!bar.querySelector('.pc-more')) failures.push('The page bar must contain More.');
    const last = [...bar.querySelectorAll('button')].at(-1);
    if (!last?.classList.contains('pc-chat') || last.getAttribute('aria-label') !== 'Chat') failures.push('Chat must be the last button in the page bar.');
  }
  const title = root.querySelector('h1.pc-title');
  if (!title) failures.push('The page must have a large title heading.');
  const walker = doc.createTreeWalker(root, 4, { acceptNode(node) { return node.textContent.trim() && !node.parentElement.closest('.pc-bar') && node.parentElement.checkVisibility() ? 1 : 3; } });
  const first = walker.nextNode();
  if (!first || !title?.contains(first)) failures.push('The first visible page text must be the large title.');
  const expected = statusLine(spec.updatedAt, spec.staleAfterMs, now);
  const status = root.querySelector('.pc-status');
  if (expected ? !status?.textContent.startsWith(expected) : Boolean(status)) failures.push('The status line must appear only for stale data and describe its age.');
  if (!validatePageMessage(pageMessage(spec)).ok) failures.push('The page description must satisfy rails/page v1.');
  return { ok: failures.length === 0, failures };
}
