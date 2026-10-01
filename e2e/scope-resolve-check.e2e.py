#!/usr/bin/env python3
"""Browser e2e for r44: Resolve is a checkmark on every open thread, always visible (owner: Opus; implementers make it pass, never edit it).

Alex (2026-09-30 19:06 ET, report rpt_2550e330608568f5): "resolve should be a checkmark i can always see so i dont need the three dot".
Serves web/dist-scope from e2e/scope-stub.mjs (port 4595). At 1280 and 390, light and dark, it proves:
  1) every open thread card (Alex's comments and the lane's question) shows a visible checkmark button in its header,
     button[data-action="resolve"] with aria-label "Resolve", even when the card is not the focused one; it carries an
     inline SVG and no text, and its hit area is at least 24x24 (desktop) or 32x32 (phone);
  2) resolved cards show Reopen and no checkmark;
  3) one click on the checkmark of an unfocused card resolves it (POST .../T4/resolve, decision "Resolved"), and with
     Resolved off the card and its highlight go; nothing else is written; the menu still offers Resolve.
usage: e2e/scope-resolve-check.e2e.py <worktree> [--no-build]
"""
import json, os, re, shutil, subprocess, sys, time, urllib.request

E = os.path.dirname(os.path.abspath(__file__))
WT = os.path.abspath(next((a for a in sys.argv[1:] if not a.startswith("--")), os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")))
DIST = os.path.join(WT, 'web', 'dist-scope')
OUT = os.environ.get('E2E_OUT') or os.path.join(os.environ.get('TMPDIR', '/tmp'), 'unblock-e2e')
W = os.path.join(OUT, f'work-{os.path.basename(__file__)}')
PORT = 4595
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
    MIN = 32 if phone else 24
    CHECK = ("(c) => { const b = c?.querySelector('.head [data-action=\"resolve\"]'); if (!b) return {ok: false, why: 'no check'}; const r = b.getBoundingClientRect(); "
             "return {ok: vis(b) && b.getAttribute('aria-label') === 'Resolve' && !!b.querySelector('svg') && b.textContent.trim() === '' && r.width >= %d && r.height >= %d && getComputedStyle(b).visibility === 'visible', w: r.width, h: r.height, label: b.getAttribute('aria-label'), text: b.textContent.trim()} }") % (MIN, MIN)
    X = H + " const card = (t) => document.querySelector(`#cards .card[data-t=\"${t}\"], #detached .card[data-t=\"${t}\"]`); const mark = (t) => document.querySelector(`mark.hl[data-t=\"${t}\"]`); const clear = %s; const check = %s;" % (CLEAR, CHECK)
    toggle = js("(() => { document.querySelector('#resolvedChip')?.click(); return true })()", 700) if phone else js("(() => { document.querySelector('#showResolved').click(); return true })()", 700)
    close = js("(() => { document.querySelector('#scrim')?.click(); return true })()") if phone else []
    sheet = lambda t: "document.querySelector('.sheet .card[data-t=\"%s\"]')" % t
    steps = [
        {'wait_for': 'mark.hl[data-t="T2"]'},
        {'wait': 400},
        *hook_steps('old_resolved'),
    ]
    if phone:
        steps += [
            *js("(() => { const m = %s; m.scrollIntoView({ block: 'center' }); m.click(); return true })()" % mark('T1'), 800),
            C(f'{label}: the lane question in the sheet shows the checkmark', X + " return check(%s)" % sheet('T1')),
            *close,
            *js("(() => { const m = %s; m.scrollIntoView({ block: 'center' }); m.click(); return true })()" % mark('T4'), 800),
            C(f'{label}: Alex\'s comment in the sheet shows the checkmark', X + " return check(%s)" % sheet('T4')),
            {'shot': f'{label}-check'},
            *js("(() => { %s.querySelector('.head [data-action=\"resolve\"]').click(); return true })()" % sheet('T4'), 1400),
            *close,
            C(f'{label}: one tap resolved it; with Resolved off its highlight is gone', X + " return {ok: clear(mark('T4')) && !vis(%s), bg: mark('T4') && getComputedStyle(mark('T4')).backgroundColor}" % sheet('T4')),
            *toggle,
            *js("(() => { const m = %s; m.scrollIntoView({ block: 'center' }); m.click(); return true })()" % mark('T4'), 800),
            C(f'{label}: a resolved thread shows Reopen and no checkmark', X + " const c = %s; return {ok: vis(c) && vis(c.querySelector('[data-action=\"reopen\"]')) && !c.querySelector('.head [data-action=\"resolve\"]')}" % sheet('T4')),
            *close,
        ]
    else:
        steps += [
            *js("(() => { %s.querySelector('.q').click(); return true })()" % card('T2'), 600),
            C(f'{label}: every open card shows the checkmark, focused or not', X + " const r = Object.fromEntries(['T1', 'T2', 'T3', 'T4'].map((t) => [t, check(card(t))])); return {ok: Object.values(r).every((x) => x.ok), r}"),
            C(f'{label}: T4 is not the focused card', X + " return {ok: !card('T4').classList.contains('on')}"),
            {'shot': f'{label}-check'},
            *js("(() => { const b = %s.querySelector('.head [data-action=\"resolve\"]'); b.scrollIntoView({ block: 'center' }); b.click(); return true })()" % card('T4'), 1400),
            C(f'{label}: one click resolved it; with Resolved off the card and highlight go', X + " return {ok: !vis(card('T4')) && clear(mark('T4'))}"),
            C(f'{label}: the other open cards keep their checkmark', X + " return {ok: ['T1', 'T2', 'T3'].every((t) => check(card(t)).ok)}"),
            *toggle,
            C(f'{label}: resolved cards show Reopen and no checkmark', X + " const r = ['T4', 'T5'].map((t) => { const c = card(t); return vis(c) && vis(c.querySelector('[data-action=\"reopen\"]')) && !c.querySelector('.head [data-action=\"resolve\"]') }); return {ok: r.every(Boolean), r}"),
            {'shot': f'{label}-resolved-on'},
            *toggle,
            *js("(() => { const t = %s.querySelector('.q'); t.scrollIntoView({ block: 'center' }); const r = t.getBoundingClientRect(); getSelection()?.removeAllRanges(); t.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 8, clientY: r.top + r.height / 2, button: 2 })); return true })()" % card('T2'), 700),
            C(f'{label}: the menu still offers Resolve', X + " const c = card('T2'); return {ok: [...c.querySelectorAll('.menu [role=menuitem]')].filter(vis).some((b) => (b.childNodes[0]?.textContent.trim() || b.textContent.trim()) === 'Resolve')}"),
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
    for shot in out.get('shots', []):
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
            want = ['/w/api/live-scopes/demo/threads/T4/resolve']
            check(f'{label}: the only write is Resolve on T4', [e['path'] for e in writes] == want, [e['path'] for e in writes])
            res = [e for e in writes if e['path'].endswith('/T4/resolve')]
            check(f'{label}: it resolves with the decision "Resolved"', len(res) == 1 and (res[0].get('body') or {}).get('decision') == 'Resolved', res)
    finally:
        stub.terminate()


run()
bad = [r for r in results if not r[1]]
print(f'\n{len(results) - len(bad)}/{len(results)} passed')
sys.exit(1 if bad else 0)
