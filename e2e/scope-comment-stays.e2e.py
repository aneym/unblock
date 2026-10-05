#!/usr/bin/env python3
"""Regression e2e: a new comment stays on screen at its text from the click until the lane's copy arrives
(owner: Opus, 2026-10-03 comment-flicker; implementers make it pass, never edit it).

Alex (2026-10-03 ~23:10 ET, Rails Admin, scoping/foundry-bench): "when i leave commment, it flashes away, then comes back a
couple secods later instead of just staying there." Development area queues the write (202) and the Studio relay lands it about
3-5 s later, so the page shows its own "Sending" card meanwhile. That card was appended after every other card in the rail,
so with cards anchored lower in the doc it sat below all of them, off screen, until the real thread arrived at its text.

Serves web/dist-scope from e2e/scope-stub.mjs in relay mode (STUB_RELAY_MS=2500: events off, the page polls every 2 s, a
POST answers 202 and lands 2.5 s later), port 4627. Eight cards sit down Later (/__spread). At 1280 light and 1440 dark:
  1) a comment on Later paragraph 5 (cards above and below it) shows at once, stays inside the viewport and within 30 px
     of where the composer was for 5.5 s, through polls before and after the write lands, and ends as one real thread card;
  2) a post Admin refuses (500) keeps the composer with the text and shows the error in place; no Sending card appears.
usage: e2e/scope-comment-stays.e2e.py <worktree> [--no-build]
"""
import json, os, shutil, subprocess, sys, time, urllib.request

E = os.path.dirname(os.path.abspath(__file__))
WT = os.path.abspath(next((a for a in sys.argv[1:] if not a.startswith("--")), os.path.join(E, "..")))
DIST = os.path.join(WT, 'web', 'dist-scope')
OUT = os.environ.get('E2E_OUT') or os.path.join(os.environ.get('TMPDIR', '/tmp'), 'unblock-e2e')
W = os.path.join(OUT, f'work-{os.path.basename(__file__)}')
PORT = 4627
RELAY_MS = 2500
results = []


def check(name, ok, detail=''):
    results.append((name, bool(ok), detail))
    print(('PASS ' if ok else 'FAIL ') + name + (f' — {detail}' if detail and not ok else ''), flush=True)


def C(name, js):
    return {'eval': f"(() => {{ try {{ const r = (() => {{ {js} }})(); return {{check: {json.dumps(name)}, ok: !!(r && r.ok !== undefined ? r.ok : r), detail: r}} }} catch (e) {{ return {{check: {json.dumps(name)}, ok: false, detail: String(e)}} }} }})()"}


def js(code, wait=600):
    return [{'eval': code}, {'wait': wait}]


def hook(q):
    return [{'eval': "fetch('/__%s').then((r) => r.json()).then(({seq}) => new Promise((done) => { const t0 = Date.now(); const tick = () => (document.body.textContent.includes(`revision ${seq}`) || Date.now() - t0 > 8000) ? done(seq) : setTimeout(tick, 100); tick() }))" % q}, {'wait': 600}]


PARA = lambda n: "[...document.querySelectorAll('#doc p')].find((p) => p.textContent.startsWith('Later paragraph %d:'))" % n


def open_composer(n):
    quote = f'wait for pass {n}'
    return js("(() => { const p = %s; p.scrollIntoView({ block: 'center' }); const t = p.firstChild, i = t.textContent.indexOf(%s); "
              "const r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + %d); const s = getSelection(); s.removeAllRanges(); s.addRange(r); "
              "const box = r.getClientRects()[0]; const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: box.left + 4, clientY: box.top + box.height / 2, button: 2 }); "
              "p.dispatchEvent(ev); return ev.defaultPrevented })()" % (PARA(n), json.dumps(quote), len(quote)), 900)


def typed(text):
    return js("(() => { const t = document.querySelector('#cards .card.composer textarea'); if (!t) return 'no composer'; t.focus(); t.value = %s; t.dispatchEvent(new Event('input', { bubbles: true })); return true })()" % json.dumps(text), 300)


# Samples every 25 ms and on every DOM change from the click: which card shows the note (the composer excluded), whether it is
# drawn and inside the viewport, and its top on screen. Counts the page's reads of the scope after the click.
SAMPLE = ("(() => { const text = %s; const vis = (e) => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).display !== 'none'; "
          "const composer = document.querySelector('#cards .card.composer'); window.__composerTop = composer.getBoundingClientRect().top; "
          "window.__reads = 0; const real = window.fetch; window.fetch = (u, o) => { if (String(u).endsWith('/w/api/live-scopes/demo') && !(o && o.method === 'POST')) window.__reads += 1; return real(u, o) }; "
          "const t0 = performance.now(); window.__tl = []; const sample = () => { const c = [...document.querySelectorAll('#cards .card:not(.composer), .sheet .card:not(.composer)')].filter((n) => vis(n) && n.textContent.includes(text)); "
          "const r = c[0]?.getBoundingClientRect(); window.__tl.push({ t: Math.round(performance.now() - t0), n: c.length, id: c[0] ? (c[0].dataset.t || (c[0].dataset.sending ? 'sending' : '?')) : null, top: r ? Math.round(r.top) : null, inView: !!r && r.top >= 0 && r.bottom <= innerHeight }) }; "
          "new MutationObserver(sample).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true }); window.__sampler = setInterval(sample, 25); "
          "document.querySelector('#cards .card.composer [data-action=\"post\"]').click(); sample(); return true })()")


def scenario(label):
    text = f'Stays put {label}'
    tl = "clearInterval(window.__sampler); const tl = window.__tl, from = tl.findIndex((s) => s.n > 0), shown = from < 0 ? [] : tl.slice(from);"
    return [
        {'wait_for': 'mark.hl[data-t="T2"]'}, {'wait': 400},
        *hook('spread'),
        {'wait_for': '#cards .card[data-t="T12"]'}, {'wait': 600},
        *open_composer(5),
        C(f'{label}: the composer opens on Later paragraph 5', "return !!document.querySelector('#cards .card.composer textarea')"),
        *typed(text),
        *js(SAMPLE % json.dumps(text), 5500),
        C(f'{label}: the note shows at once after the click', tl + " return {ok: from >= 0 && tl[from].t <= 300, first: tl[from]}"),
        C(f'{label}: the note never leaves the screen for 5.5 s', tl + " const gone = shown.filter((s) => s.n === 0 || !s.inView); return {ok: shown.length > 0 && tl.at(-1).t >= 5000 && gone.length === 0, gone: gone.slice(0, 5), last: tl.at(-1)}"),
        C(f'{label}: the note stays where the composer was', tl + " const off = shown.filter((s) => s.top !== null && Math.abs(s.top - window.__composerTop) > 30); return {ok: off.length === 0, composer: Math.round(window.__composerTop), off: off.slice(0, 5)}"),
        C(f'{label}: the page read the scope before and after the write landed', tl + " return {ok: window.__reads >= 2 && shown.some((s) => s.id === 'sending') && tl.at(-1).id?.startsWith('T'), reads: window.__reads, ids: [...new Set(shown.map((s) => s.id))]}"),
        C(f'{label}: one card carries the note at the end, the real comment', "const c = [...document.querySelectorAll('#cards .card:not(.composer)')].filter((n) => n.textContent.includes(%s)); return {ok: c.length === 1 && !!c[0].dataset.t && !c[0].dataset.sending, n: c.length, t: c[0]?.dataset.t}" % json.dumps(text)),
        # A post Admin refuses keeps his words in the composer with the error beside them.
        *js("fetch('/__fail_next').then(() => true)", 300),
        *open_composer(9),
        *typed(text + ' refused'),
        *js("(() => { document.querySelector('#cards .card.composer [data-action=\"post\"]').click(); return true })()", 1500),
        C(f'{label}: a refused post keeps the composer, the text and an error', "const c = document.querySelector('#cards .card.composer'), err = c?.querySelector('.error'); return {ok: !!c && c.querySelector('textarea')?.value === %s && !!err && err.textContent.trim().length > 0, error: err?.textContent}" % json.dumps(text + ' refused')),
        C(f'{label}: a refused post shows no Sending card', "return {ok: ![...document.querySelectorAll('#cards .card[data-sending]')].some((n) => n.textContent.includes(%s))}" % json.dumps(text + ' refused')),
    ]


def page_shot(route, steps, width, theme, label):
    f = os.path.join(W, f'steps-{label}.json')
    json.dump(steps, open(f, 'w'))
    cmd = [os.path.expanduser('~/.local/bin/page-shot'), f'http://127.0.0.1:{PORT}{route}', '--out', os.path.join(OUT, 'shots'), '--widths', str(width),
           '--themes', theme, '--viewport-only', '--steps', f, '--timeout', '60']
    p = subprocess.run(cmd, capture_output=True, text=True)
    try:
        out = json.loads(p.stdout)
    except json.JSONDecodeError:
        check(f'{label}: page-shot ran', False, (p.stdout + p.stderr)[-1500:])
        return
    check(f'{label}: page-shot exited 0', p.returncode == 0, (p.stderr or '')[-600:])
    want = sum(1 for step in steps if 'eval' in step)
    for shot in out.get('shots', []):
        check(f'{label}: every eval step returned', len(shot.get('evals', [])) == want, f"{len(shot.get('evals', []))}/{want}")
        for ev in shot.get('evals', []):
            v = ev['value']
            if isinstance(v, dict) and 'check' in v:
                check(v['check'], v['ok'], json.dumps(v.get('detail'))[:600])
        check(f'{label}: steps ran to the end', not shot.get('error'), shot.get('error'))
    errors = [e for e in (out.get('console_errors') or []) if 'Content Security Policy' not in str(e) and '500' not in str(e)]
    check(f'{label}: no console errors', not errors, str(errors)[:600])
    print('shots:', out.get('dir'), flush=True)


def reset(log):
    urllib.request.urlopen(urllib.request.Request(f'http://127.0.0.1:{PORT}/__reset', data=b'{}', method='POST')).read()
    open(log, 'w').close()


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
    stub = subprocess.Popen(['node', os.path.join(E, 'scope-stub.mjs'), str(PORT), WT, DIST, log, 'embed'], env={**os.environ, 'STUB_RELAY_MS': str(RELAY_MS)},
                            stdout=open(os.path.join(W, f'stub-{PORT}.out'), 'w'), stderr=subprocess.STDOUT)
    try:
        for _ in range(50):
            try:
                urllib.request.urlopen(f'http://127.0.0.1:{PORT}/scope/demo').read()
                break
            except Exception:
                time.sleep(0.2)
        for width, theme in ((1280, 'light'), (1440, 'dark')):
            reset(log)
            label = f'{width}-{theme}'
            page_shot('/scope/demo', scenario(label), width, theme, label)
            posts = [e for e in (json.loads(l) for l in open(log) if l.strip()) if e['method'] == 'POST' and e['path'] == '/w/api/live-scopes/demo/threads']
            check(f'{label}: two posts, on the selected text', [p['body']['anchor']['quote'] for p in posts] == ['wait for pass 5', 'wait for pass 9'], [p['body'].get('anchor') for p in posts])
    finally:
        stub.terminate()


run()
bad = [r for r in results if not r[1]]
print(f'\n{len(results) - len(bad)}/{len(results)} passed')
sys.exit(1 if bad else 0)
