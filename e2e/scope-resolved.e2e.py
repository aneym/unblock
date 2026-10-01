#!/usr/bin/env python3
"""Regression e2e (kept in the repo since 2026-09-30; p6: resolved comments took four reports to fix). Browser e2e for r41: resolved threads hide with Resolved off; Reopen; a right-click / long-press thread menu
(owner: Opus; implementers make it pass, never edit it).

Alex (2026-09-30 13:19 ET): Resolved toggle off must hide EVERY resolved card, including one resolved minutes ago.
Alex (14:32 ET): resolved highlights still show inline; detached resolved cards too.
Alex (14:55 ET): "need to be able to unresovle comments, and right click to see options btw."
Serves web/dist-scope from scope-stub.mjs (port 4594). At 1280 and 390, light and dark, it proves:
  1) with Resolved off, a thread resolved just now (T1), one resolved two days ago (T5) and a detached resolved one (T6)
     show no card, no Detached heading and no inline highlight, and their highlight does not open them;
  2) Resolved on shows them, each with Reopen; Reopen puts T5 back to open, and it stays with Resolved off;
  3) desktop: right-click on a card or on a highlight opens its menu (Reply, Resolve or Reopen, Copy link, Jump to
     text, Delete on Alex's own notes); Escape closes it; Copy link copies <page>#thread=T<n>, which opens that thread;
     Jump to text brings the highlight into view; Delete asks once, then removes his note;
  4) phone: a long press on a highlight opens the same menu in the sheet.
usage: e2e/scope-resolved.e2e.py <worktree> [--no-build]
"""
import json, os, re, shutil, subprocess, sys, time, urllib.request

E = os.path.dirname(os.path.abspath(__file__))
WT = os.path.abspath(next((a for a in sys.argv[1:] if not a.startswith("--")), os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")))
DIST = os.path.join(WT, 'web', 'dist-scope')
OUT = os.environ.get('E2E_OUT') or os.path.join(os.environ.get('TMPDIR', '/tmp'), 'unblock-e2e')
W = os.path.join(OUT, f'work-{os.path.basename(__file__)}')
PORT = 4594
results = []


def check(name, ok, detail=''):
    results.append((name, bool(ok), detail))
    print(('PASS ' if ok else 'FAIL ') + name + (f' — {detail}' if detail and not ok else ''), flush=True)


def C(name, js):
    return {'eval': f"(() => {{ try {{ const r = (() => {{ {js} }})(); return {{check: {json.dumps(name)}, ok: !!(r && r.ok !== undefined ? r.ok : r), detail: r}} }} catch (e) {{ return {{check: {json.dumps(name)}, ok: false, detail: String(e)}} }} }})()"}


VISIBLE = "(e) => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).display !== 'none'"
NO_ERRORS = "const e = window.__errs || []; const csp = (window.__csp || []).filter((x) => x.startsWith('script') || x.startsWith('img')); return {ok: e.length === 0 && csp.length === 0, e, csp}"
H = ("const vis = %s; const where = (t) => document.querySelector(`.sheet .card[data-t=\"${t}\"]`) || document.querySelector(`#cards .card[data-t=\"${t}\"]`); "
     "const box = (t) => where(t)?.querySelector(`textarea[data-draft=\"${t}\"]`); "
     "const loaded = (img) => !!img && img.complete && img.naturalWidth > 0; "
     "const drafts = (c) => [...(c?.querySelectorAll('.thumbs.draft .thumb img') || [])]; "
     "const sent = (c) => [...(c?.querySelectorAll('.thumbs:not(.draft) .thumb img') || [])];") % VISIBLE
# Makes an image File in the page: a w x h canvas in one colour, encoded as type.
MK = ("const mk = (w, h, color, type = 'image/png', name = 'shot.png') => new Promise((ok) => { const c = document.createElement('canvas'); c.width = w; c.height = h; "
      "const x = c.getContext('2d'); x.fillStyle = color; x.fillRect(0, 0, w, h); c.toBlob((b) => ok(new File([b], name, { type })), type) });")
SVGFILE = "new File(['<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"10\" height=\"10\"/>'], 'x.svg', { type: 'image/svg+xml' })"


def paste(target, files):
    """Paste files (JS expressions using mk) into the element target (a JS expression) as a real paste event."""
    return [{'eval': "(async () => { %s const t = %s; if (!t) return 'no target'; t.focus(); const dt = new DataTransfer(); for (const f of await Promise.all([%s])) dt.items.add(f); "
                     "const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }); t.dispatchEvent(ev); window.__pastePrevented = ev.defaultPrevented; return ev.defaultPrevented })()" % (MK, target, ', '.join(files))},
            {'wait': 1500}]


def drop(target, files):
    return [{'eval': "(async () => { %s const t = %s; if (!t) return 'no target'; const dt = new DataTransfer(); for (const f of await Promise.all([%s])) dt.items.add(f); "
                     "for (const type of ['dragenter', 'dragover', 'drop']) t.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt })); return true })()" % (MK, target, ', '.join(files))},
            {'wait': 1800}]


def js(code, wait=600):
    return [{'eval': code}, {'wait': wait}]


def typed(target, text):
    return js("(() => { const t = %s; t.focus(); t.value = %s; t.dispatchEvent(new Event('input', { bubbles: true })); return true })()" % (target, json.dumps(text)), 200)


def reload():
    return [{'eval': "(() => { setTimeout(() => location.reload(), 50); return true })()"}, {'wait': 2500}, {'wait_for': 'mark.hl[data-t="T2"]'}, {'wait': 800}]


def scenario(phone, label):
    card = lambda t: "document.querySelector('#cards .card[data-t=\"%s\"], #detached .card[data-t=\"%s\"]')" % (t, t)
    mark = lambda t: "document.querySelector('mark.hl[data-t=\"%s\"]')" % t
    CLEAR = "(m) => !!m && getComputedStyle(m).backgroundColor === 'rgba(0, 0, 0, 0)'"
    items = "(root) => [...(root?.querySelectorAll('.menu [role=menuitem]') || [])].filter(vis).map((b) => b.childNodes[0]?.textContent.trim() || b.textContent.trim())"
    menu = "(root) => [...(root?.querySelectorAll('.menu[role=menu]') || [])].find(vis)"
    toggle = js("(() => { document.querySelector('#resolvedChip')?.click(); return true })()", 700) if phone else js("(() => { document.querySelector('#showResolved').click(); return true })()", 700)
    close = js("(() => { document.querySelector('#scrim')?.click(); return true })()") if phone else []
    ctx = lambda target: js("(() => { const t = %s; if (!t) return 'no target'; t.scrollIntoView({ block: 'center' }); const r = t.getBoundingClientRect(); getSelection()?.removeAllRanges(); const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + Math.min(8, r.width / 2), clientY: r.top + r.height / 2, button: 2 }); t.dispatchEvent(ev); window.__ctxPrevented = ev.defaultPrevented; return ev.defaultPrevented })()" % target, 600)
    esc = js("(() => { (document.activeElement || document).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true })()", 400)
    pick = lambda where, text: js("(() => { const b = [...(%s)?.querySelectorAll('.menu [role=menuitem]') || []].find((x) => (x.childNodes[0]?.textContent.trim() || x.textContent.trim()) === %s); b?.click(); return !!b })()" % (where, json.dumps(text)), 700)
    X = H + " const card = (t) => document.querySelector(`#cards .card[data-t=\"${t}\"], #detached .card[data-t=\"${t}\"]`); const mark = (t) => document.querySelector(`mark.hl[data-t=\"${t}\"]`); const clear = %s; const items = %s; const menu = %s;" % (CLEAR, items, menu)
    steps = [
        {'wait_for': 'mark.hl[data-t="T2"]'},
        {'wait': 400},
        *hook_steps('alex_take?thread=T1'),
        *hook_steps('old_resolved'),
        *hook_steps('detached_resolved'),
        # 1. Resolved off: nothing resolved shows, in the rail, the Detached group or inline.
        C(f'{label}: with Resolved off no resolved card shows (just resolved, old, detached)', X + " const shown = ['T1', 'T5', 'T6'].filter((t) => vis(card(t)) || vis(where(t))); return {ok: shown.length === 0, shown}"),
        C(f'{label}: no Detached heading when every detached thread is resolved', X + " const d = document.querySelector('#detached'); return {ok: !d || !vis(d) || !/Detached/.test(d.textContent), text: d?.textContent}"),
        C(f'{label}: resolved text is not highlighted inline', X + " return {ok: clear(mark('T1')) && clear(mark('T5')), t1: mark('T1') && getComputedStyle(mark('T1')).backgroundColor}"),
        C(f'{label}: the open threads still show', X + " return {ok: vis(mark('T2')) && !clear(mark('T2')) && (%s || (vis(card('T2')) && vis(card('T4'))))}" % ('true' if phone else 'false')),
        *js("(() => { %s?.click(); return true })()" % mark('T1'), 600),
        C(f'{label}: a resolved highlight does not open its thread while Resolved is off', X + " return {ok: !document.querySelector('.card.on[data-t=\"T1\"]') && !vis(document.querySelector('.sheet .card[data-t=\"T1\"]'))}"),
        {'shot': f'{label}-resolved-off'},
        *close,
        # 2. Resolved on: they show, each with Reopen.
        *toggle,
        C(f'{label}: Resolved on highlights resolved text again', X + " return {ok: !clear(mark('T1')) && !clear(mark('T5'))}"),
    ]
    if phone:
        steps += [
            *js("(() => { %s.click(); return true })()" % mark('T5'), 700),
            C(f'{label}: the resolved thread opens with a Reopen button', X + " const c = document.querySelector('.sheet .card[data-t=\"T5\"]'), b = c?.querySelector('[data-action=\"reopen\"]'); return {ok: vis(c) && vis(b) && b.textContent.trim() === 'Reopen'}"),
            {'shot': f'{label}-reopen'},
            *js("(() => { document.querySelector('.sheet .card[data-t=\"T5\"] [data-action=\"reopen\"]').click(); return true })()", 1200),
            C(f'{label}: Reopen puts it back to open', X + " const c = document.querySelector('.sheet .card[data-t=\"T5\"]') || card('T5'); return {ok: !!c && !c.classList.contains('resolved') && !c.querySelector('[data-action=\"reopen\"]'), cls: c?.className}"),
            *close,
        ]
    else:
        steps += [
            C(f'{label}: Resolved on shows the three, each with Reopen', X + " const r = ['T1', 'T5', 'T6'].map((t) => { const c = card(t), b = c?.querySelector('[data-action=\"reopen\"]'); return vis(c) && vis(b) && b.textContent.trim() === 'Reopen' }); return {ok: r.every(Boolean), r}"),
            # The menu on a resolved lane question: Reopen instead of Resolve, and no Delete (it is the lane's).
            *ctx(card('T1')),
            C(f'{label}: right-click on a resolved lane question offers Reopen, not Resolve or Delete', X + " const c = card('T1'); return {ok: window.__ctxPrevented === true && vis(menu(c)) && JSON.stringify(items(c)) === JSON.stringify(['Reply', 'Reopen', 'Copy link', 'Jump to text']), items: items(c)}"),
            *esc,
            {'shot': f'{label}-resolved-on'},
            *js("(() => { const b = %s.querySelector('[data-action=\"reopen\"]'); b.scrollIntoView({ block: 'center' }); b.click(); return true })()" % card('T5'), 1200),
            C(f'{label}: Reopen puts it back to open', X + " const c = card('T5'); return {ok: vis(c) && !c.classList.contains('resolved') && !c.querySelector('[data-action=\"reopen\"]'), cls: c?.className}"),
        ]
    steps += [
        *toggle,
        C(f'{label}: the reopened thread stays with Resolved off; the others hide again', X + " return {ok: !clear(mark('T5')) && clear(mark('T1')) && (%s || (vis(card('T5')) && !vis(card('T1')) && !vis(card('T6')))), t5: mark('T5') && getComputedStyle(mark('T5')).backgroundColor}" % ('true' if phone else 'false')),
    ]
    if phone:
        steps += [
            # 4. A long press on a highlight opens the thread with its menu.
            *js("(() => { const m = %s; m.scrollIntoView({ block: 'center' }); const r = m.getBoundingClientRect(), x = r.left + 6, y = r.top + r.height / 2; window.__lp = { m, x, y }; "
                "m.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y })); "
                "try { m.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: [new Touch({ identifier: 1, target: m, clientX: x, clientY: y })] })) } catch {} return true })()" % mark('T4'), 800),
            *js("(() => { const { m, x, y } = window.__lp; m.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y })); "
                "try { m.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true, changedTouches: [new Touch({ identifier: 1, target: m, clientX: x, clientY: y })] })) } catch {} return true })()", 700),
            C(f'{label}: a long press opens the thread with its menu', X + " const c = document.querySelector('.sheet .card[data-t=\"T4\"]'); return {ok: vis(c) && vis(menu(c)) && JSON.stringify(items(c)) === JSON.stringify(['Reply', 'Resolve', 'Copy link', 'Jump to text', 'Delete']), items: items(c)}"),
            {'shot': f'{label}-long-press'},
            *esc,
            C(f'{label}: Escape closes the menu', X + " return {ok: ![...document.querySelectorAll('.menu[role=menu]')].some(vis)}"),
            *close,
        ]
    else:
        steps += [
            # 3. Right-click on a card, then on a highlight.
            *ctx("%s.querySelector('.q')" % card('T2')),
            C(f'{label}: right-click on Alex\'s comment opens its menu', X + " const c = card('T2'); return {ok: window.__ctxPrevented === true && vis(menu(c)) && JSON.stringify(items(c)) === JSON.stringify(['Reply', 'Resolve', 'Copy link', 'Jump to text', 'Delete']), items: items(c)}"),
            {'shot': f'{label}-menu'},
            *esc,
            C(f'{label}: Escape closes the menu', X + " return {ok: ![...document.querySelectorAll('.menu[role=menu]')].some(vis)}"),
            *ctx(mark('T4')),
            C(f'{label}: right-click on a highlight opens that thread\'s menu', X + " const c = card('T4'); return {ok: window.__ctxPrevented === true && c.classList.contains('on') && vis(menu(c)), cls: c.className}"),
            # Copy link.
            *js("(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => { window.__copied = t } } }); return true })()", 100),
            *pick(card('T4'), 'Copy link'),
            C(f'{label}: Copy link copies the page link with #thread=T4', X + " return {ok: window.__copied === location.origin + location.pathname + location.search + '#thread=T4', copied: window.__copied}"),
            # Jump to text.
            *js("(() => { scrollTo(0, document.documentElement.scrollHeight); return true })()", 400),
            *ctx("%s.querySelector('.q')" % card('T4')),
            *pick(card('T4'), 'Jump to text'),
            C(f'{label}: Jump to text brings the highlight into view', X + " const r = mark('T4').getBoundingClientRect(); return {ok: r.top >= 0 && r.bottom <= innerHeight, top: r.top}"),
            # The link opens the thread.
            *js("(() => { history.replaceState(null, '', location.pathname + location.search + '#thread=T4'); setTimeout(() => location.reload(), 50); return true })()", 2500),
            {'wait_for': 'mark.hl[data-t="T2"]'},
            {'wait': 900},
            C(f'{label}: a #thread= link opens that thread', X + " return {ok: !!document.querySelector('#cards .card.on[data-t=\"T4\"]')}"),
            *js("(() => { history.replaceState(null, '', location.pathname + location.search); return true })()", 100),
            # Delete asks once, then removes his note.
            *ctx("%s.querySelector('.q')" % card('T2')),
            *pick(card('T2'), 'Delete'),
            C(f'{label}: Delete asks once before it deletes', X + " const c = card('T2'); const b = c?.querySelector('[data-action=\"confirm-delete\"]'); return {ok: vis(c) && vis(b), text: c?.textContent}"),
            *js("(() => { %s.querySelector('[data-action=\"confirm-delete\"]').click(); return true })()" % card('T2'), 1200),
            C(f'{label}: his note is gone from the rail and the text', X + " return {ok: !card('T2') && !mark('T2')}"),
            {'shot': f'{label}-deleted'},
        ]
    steps.append(C(f'{label}: no page error', NO_ERRORS))
    return steps


def hook_steps(q):
    return [{'eval': "fetch('/__%s').then((r) => r.json()).then(({seq}) => new Promise((done) => { const t0 = Date.now(); const tick = () => (document.querySelector('#title .meta')?.textContent.includes(`Revision ${seq} `) || document.body.textContent.includes(`revision ${seq}`) || Date.now() - t0 > 8000) ? done(seq) : setTimeout(tick, 100); tick() }))" % q}, {'wait': 400}]


def page_shot(route, steps, width, theme, label):
    f = os.path.join(W, f'steps-{label}.json')
    json.dump(steps, open(f, 'w'))
    cmd = [os.path.expanduser('~/.local/bin/page-shot'), f'http://127.0.0.1:{PORT}{route}', '--out', os.path.join(OUT, 'shots'), '--widths', str(width),
           '--themes', theme, '--viewport-only', '--steps', f, '--timeout', '60']
    if width < 600:
        cmd.append('--touch')
    p = subprocess.run(cmd, capture_output=True, text=True)
    try:
        out = json.loads(p.stdout)
    except json.JSONDecodeError:
        check(f'{label}: page-shot ran', False, (p.stdout + p.stderr)[-1500:])
        return
    check(f'{label}: page-shot exited 0', p.returncode == 0, (p.stderr or '')[-600:])
    check(f'{label}: page-shot took a shot', bool(out.get('shots')))
    want = sum(1 for step in steps if 'eval' in step)
    for shot in out.get('shots', []):
        check(f'{label}: every eval step returned', len(shot.get('evals', [])) == want, f"{len(shot.get('evals', []))}/{want}")
        for ev in shot.get('evals', []):
            v = ev['value']
            if isinstance(v, dict) and 'check' in v:
                check(v['check'], v['ok'], json.dumps(v.get('detail'))[:400])
        check(f'{label}: steps ran to the end', not shot.get('error'), shot.get('error'))
        check(f'{label}: no horizontal overflow', not shot.get('overflow_x'))
    errors = [e for e in (out.get('console_errors') or []) if 'Content Security Policy' not in str(e) or 'script' in str(e) or 'img' in str(e)]
    check(f'{label}: no console errors', not errors, str(errors)[:600])
    print('shots:', out.get('dir'), flush=True)


def reset(log):
    urllib.request.urlopen(urllib.request.Request(f'http://127.0.0.1:{PORT}/__reset', data=b'{}', method='POST')).read()
    open(log, 'w').close()


def entries(log):
    return [json.loads(l) for l in open(log) if l.strip()]


def run():
    subprocess.run(['pkill', '-f', f'scope-stub.mjs {PORT}'], capture_output=True)
    shutil.rmtree(W, ignore_errors=True)
    os.makedirs(W)
    env = {**os.environ, 'PATH': os.path.join(WT, 'web', 'node_modules', '.bin') + ':' + os.environ['PATH']}
    if '--no-build' not in sys.argv:
        b = subprocess.run(['npm', 'run', 'build:scope-bundle'], cwd=WT, env=env, capture_output=True, text=True)
        check('bundle builds', b.returncode == 0, (b.stdout + b.stderr)[-1500:])
        if b.returncode:
            return
    log = os.path.join(W, f'stub-{PORT}.log')
    stub = subprocess.Popen(['node', os.path.join(E, 'scope-stub.mjs'), str(PORT), WT, DIST, log, 'solo'], stdout=open(os.path.join(W, f'stub-{PORT}.out'), 'w'), stderr=subprocess.STDOUT)
    try:
        for _ in range(50):
            try:
                urllib.request.urlopen(f'http://127.0.0.1:{PORT}/scope/demo').read()
                break
            except Exception:
                time.sleep(0.2)
        for width, theme in ((1280, 'light'), (1280, 'dark'), (390, 'light'), (390, 'dark')):
            reset(log)
            label = f'{width}-{theme}'
            page_shot('/scope/demo', scenario(width < 600, label), width, theme, label)
            writes = [e for e in entries(log) if e['method'] == 'POST' and e['path'].startswith('/w/api/live-scopes/demo/threads')]
            want = ['/w/api/live-scopes/demo/threads/T5/reopen'] + (['/w/api/live-scopes/demo/threads/T2/delete'] if width >= 600 else [])
            check(f'{label}: the only writes are Reopen on T5' + (' and Delete on T2' if width >= 600 else ''), [e['path'] for e in writes] == want, [e['path'] for e in writes])
    finally:
        stub.terminate()


run()
bad = [r for r in results if not r[1]]
print(f'\n{len(results) - len(bad)}/{len(results)} passed')
sys.exit(1 if bad else 0)
