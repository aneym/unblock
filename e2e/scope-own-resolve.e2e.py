#!/usr/bin/env python3
"""E2E: Alex resolves his own comments in one tap, sees a lane's new reply until he reads it, and a write Admin could not
deliver shows in place (owner: Opus, 2026-10-03 resolve-rule; implementers make it pass, never edit it).

Alex (2026-10-03 ~23:15 ET): "you're resolving comments before i read the response to my question, another falw in the
commenting system. i should just have an easy button to resolve it myself, unless its obvious that i want ou to close it?"
And two of his "reopen T1" writes in Rails Admin were dropped without a word (the relay got 403 RELAY_SCOPE_ONLY and acked
them); his own actions must never vanish silently.

Serves web/dist-scope from e2e/scope-stub.mjs in relay mode (STUB_RELAY_MS=1500: the page polls every 2 s, a POST answers
202 and lands 1.5 s later; /__relay_fail_next makes the next write come back in failed[] instead), port 4628.
At 1280 light and 390 dark:
  1) an open comment card (T2, his) and a lane-ask card (T1) each show a labelled "Resolve" button beside Reply, as tall as
     Reply and at least 24 px (32 px on the phone); one tap on T2's resolves it (how "resolve") and no Sending line stays;
  2) a lane reply he has not seen marks the card with a small blue dot or bold, never a red badge;
  3) a lane resolving that thread does not hide it: with Resolved off it still shows, still marked, with the lane's reply,
     until he opens it; after he has read it and moved on, it hides;
  4) a reply Admin could not deliver turns into "Not sent" on that card, keeps his words, offers Try again, and Try again
     lands it; on desktop a new comment Admin could not deliver stays at its text as "Not sent" with Dismiss;
  5) Reopen through Admin lands and settles (no Sending line left).
usage: e2e/scope-own-resolve.e2e.py <worktree> [--no-build]
"""
import json, os, shutil, subprocess, sys, time, urllib.request

E = os.path.dirname(os.path.abspath(__file__))
WT = os.path.abspath(next((a for a in sys.argv[1:] if not a.startswith("--")), os.path.join(E, "..")))
DIST = os.path.join(WT, 'web', 'dist-scope')
OUT = os.environ.get('E2E_OUT') or os.path.join(os.environ.get('TMPDIR', '/tmp'), 'unblock-e2e')
W = os.path.join(OUT, f'work-{os.path.basename(__file__)}')
PORT = 4628
RELAY_MS = 1500
LAND = 4800  # relay delay + one poll + slack
results = []


def check(name, ok, detail=''):
    results.append((name, bool(ok), detail))
    print(('PASS ' if ok else 'FAIL ') + name + (f' — {detail}' if detail and not ok else ''), flush=True)


VISIBLE = "(e) => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).display !== 'none'"
H = ("const vis = %s; const where = (t) => document.querySelector(`.sheet .card[data-t=\"${t}\"]`) || document.querySelector(`#cards .card[data-t=\"${t}\"]`); "
     "const mark = (t) => document.querySelector(`mark.hl[data-t=\"${t}\"]`); "
     "const btn = (c, label) => [...(c?.querySelectorAll('button') || [])].find((b) => b.textContent.trim() === label && vis(b)); "
     "const rgb = (s) => (s.match(/[0-9.]+/g) || []).map(Number); "
     "const red = (e) => { const [r, g, b, a] = rgb(getComputedStyle(e).backgroundColor); return a !== 0 && r > 170 && g < 110 && b < 110 }; "
     "const marked = (c) => { if (!c) return {ok: false, why: 'no card'}; const dot = [...c.querySelectorAll('.unread-dot, [data-unread]')].find(vis); "
     "  const [r, g, b] = dot ? rgb(getComputedStyle(dot).backgroundColor) : []; const blue = !!dot && b > r + 40 && b >= g; const small = !!dot && dot.getBoundingClientRect().width <= 10; "
     "  const bold = Number(getComputedStyle(c.querySelector('.q') || c).fontWeight) >= 600; const badge = [...c.querySelectorAll('*')].some((e) => vis(e) && red(e)); "
     "  return {ok: ((blue && small) || bold) && !badge && /new (reply|answer)/i.test((dot?.getAttribute('aria-label') || '') + ' ' + (dot?.title || '') + ' ' + c.textContent), blue, small, bold, badge} };") % VISIBLE


def C(name, js):
    return {'eval': f"(() => {{ try {{ {H} const r = (() => {{ {js} }})(); return {{check: {json.dumps(name)}, ok: !!(r && r.ok !== undefined ? r.ok : r), detail: r}} }} catch (e) {{ return {{check: {json.dumps(name)}, ok: false, detail: String(e)}} }} }})()"}


def js(code, wait=600):
    return [{'eval': code}, {'wait': wait}]


def hook(q, wait=LAND):
    return [{'eval': "fetch('/__%s').then((r) => r.json()).then(({seq}) => seq)" % q}, {'wait': wait}]


def open_thread(t):
    return js("(() => { const m = document.querySelector('mark.hl[data-t=\"%s\"]'); if (!m) return 'no mark'; m.scrollIntoView({ block: 'center' }); m.click(); return true })()" % t, 900)


def side_by_side(t, minimum):
    return ("const c = where(%s); const r = btn(c, 'Resolve'), reply = btn(c, 'Reply'); if (!r || !reply) return {ok: false, resolve: !!r, reply: !!reply}; "
            "const a = r.getBoundingClientRect(), b = reply.getBoundingClientRect(); "
            "return {ok: r.dataset.action === 'resolve' && r.parentElement === reply.parentElement && Math.abs(a.top - b.top) < 4 && a.height >= %d && Math.abs(a.height - b.height) < 3, h: a.height, top: [a.top, b.top]}") % (json.dumps(t), minimum)


def open_composer(n):
    quote = f'wait for pass {n}'
    para = "[...document.querySelectorAll('#doc p')].find((p) => p.textContent.startsWith('Later paragraph %d:'))" % n
    return js("(() => { const p = %s; p.scrollIntoView({ block: 'center' }); const t = p.firstChild, i = t.textContent.indexOf(%s); "
              "const r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + %d); const s = getSelection(); s.removeAllRanges(); s.addRange(r); "
              "const box = r.getClientRects()[0]; const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: box.left + 4, clientY: box.top + box.height / 2, button: 2 }); "
              "p.dispatchEvent(ev); return ev.defaultPrevented })()" % (para, json.dumps(quote), len(quote)), 900)


def scenario(phone, label):
    MIN = 32 if phone else 24
    close = js("(() => { document.querySelector('#scrim')?.click(); return true })()", 500) if phone else []
    toggle = js("(() => { (document.querySelector('#resolvedChip:not([hidden])') || document.querySelector('#showResolved')).click(); return true })()", 700)
    steps = [
        {'wait_for': 'mark.hl[data-t="T2"]'}, {'wait': 500},
        # 1. The labelled Resolve beside Reply, on his comment and on a lane ask.
        *open_thread('T2'),
        C(f'{label}: his open comment shows Resolve beside Reply', side_by_side('T2', MIN)),
        {'shot': f'{label}-resolve-comment'},
        *close,
        *open_thread('T1'),
        C(f'{label}: a lane ask shows Resolve beside Reply', side_by_side('T1', MIN)),
        {'shot': f'{label}-resolve-ask'},
        *close,
        *open_thread('T2'),
        *js("(() => { %s const b = btn(where('T2'), 'Resolve'); if (!b) return 'no Resolve'; b.click(); return true })()" % H, LAND),
        *close,
        C(f'{label}: one tap resolved T2 and nothing is left sending', "return {ok: !mark('T2') || getComputedStyle(mark('T2')).backgroundColor === 'rgba(0, 0, 0, 0)' || mark('T2').classList.contains('resolved'), sending: [...document.querySelectorAll('.sending')].map((s) => s.textContent)}"),
        C(f'{label}: no Sending line stays after the resolve lands', "return {ok: ![...document.querySelectorAll('.sending')].some(vis), left: [...document.querySelectorAll('.sending')].map((s) => s.textContent)}"),
        # 2. A lane reply he has not seen.
        *hook('lane_answer?thread=T4'),
    ]
    if phone:
        steps += [
            C(f'{label}: the highlight of a card with an unseen reply is marked', "return {ok: !!mark('T4') && mark('T4').classList.contains('unread')}"),
            *open_thread('T4'),
            C(f'{label}: the card shows a quiet new-reply marker, no red badge', "return marked(where('T4'))"),
            {'shot': f'{label}-new-reply'},
            *close,
            *open_thread('T1'), *close,
            C(f'{label}: once read, the marker goes', "return {ok: !mark('T4')?.classList.contains('unread')}"),
            # 3. A lane resolve does not hide a reply he has not read.
            *hook('lane_answer?thread=T3', 600), *hook('agent_resolve?thread=T3'),
            C(f'{label}: a lane-resolved thread with an unseen reply keeps its highlight, marked', "const m = mark('T3'); return {ok: !!m && m.classList.contains('unread') && getComputedStyle(m).backgroundColor !== 'rgba(0, 0, 0, 0)', cls: m?.className}"),
        ]
    else:
        steps += [
            *js("(() => { document.querySelector('#cards .card[data-t=\"T1\"] .q')?.click(); return true })()", 600),
            C(f'{label}: a card with an unseen reply shows a quiet new-reply marker, no red badge', "return marked(where('T4'))"),
            {'shot': f'{label}-new-reply'},
            # 3. A lane resolve does not hide a reply he has not read.
            *hook('agent_resolve?thread=T4'),
            C(f'{label}: with Resolved off, the lane-resolved T4 still shows, marked, with the reply', "const c = where('T4'); return {ok: vis(c) && marked(c).ok && c.textContent.includes('Yes, Sol 6.1 medium.'), shown: vis(c), marked: marked(c)}"),
            {'shot': f'{label}-lane-resolved-unseen'},
            *js("(() => { document.querySelector('#cards .card[data-t=\"T4\"] .q').click(); return true })()", 900),
            *js("(() => { document.querySelector('#cards .card[data-t=\"T1\"] .q').click(); return true })()", 900),
            C(f'{label}: once read and left, the resolved T4 hides with Resolved off', "return {ok: !vis(where('T4'))}"),
        ]
    # 4. A reply Admin could not deliver.
    steps += [
        *hook('relay_fail_next?status=403&error=RELAY_SCOPE_ONLY', 300),
        *open_thread('T1'),
        *js("(() => { %s const c = where('T1'), t = c.querySelector('textarea[data-draft=\"T1\"]'); t.focus(); t.value = 'Reopen the plan'; t.dispatchEvent(new Event('input', { bubbles: true })); btn(c, 'Reply').click(); return true })()" % H, LAND),
        C(f'{label}: an undelivered reply says Not sent on its card, keeps his words and offers Try again',
          "const c = where('T1'); const alert = [...(c?.querySelectorAll('[role=\"alert\"], .not-sent') || [])].find((e) => vis(e) && /not sent/i.test(e.textContent)); "
          "const kept = c.textContent.includes('Reopen the plan') || c.querySelector('textarea[data-draft=\"T1\"]')?.value === 'Reopen the plan'; "
          "return {ok: !!alert && kept && !!btn(c, 'Try again') && ![...c.querySelectorAll('.sending')].some((s) => vis(s) && /Sending/.test(s.textContent)), alert: alert?.textContent, kept}"),
        {'shot': f'{label}-not-sent'},
        *js("(() => { %s btn(where('T1'), 'Try again').click(); return true })()" % H, LAND),
        C(f'{label}: Try again lands the reply and clears the error', "const c = where('T1'); return {ok: !!c && [...c.querySelectorAll('.msg')].some((m) => m.textContent.includes('Reopen the plan')) && ![...c.querySelectorAll('[role=\"alert\"], .not-sent')].some((e) => vis(e) && /not sent/i.test(e.textContent))}"),
        *close,
        # 5. Reopen through Admin lands and settles.
        *toggle,
        *open_thread('T2'),
        *js("(() => { %s const c = where('T2'); const b = btn(c, 'Reopen'); if (!b) return 'no Reopen'; b.click(); return true })()" % H, LAND),
        C(f'{label}: Reopen lands; T2 is open and nothing is left sending', "const c = where('T2'); return {ok: !!c && !c.classList.contains('resolved') && ![...document.querySelectorAll('.sending')].some(vis), cls: c?.className}"),
        *close,
    ]
    if not phone:
        steps += [
            *hook('relay_fail_next?status=403&error=RELAY_SCOPE_ONLY', 300),
            *open_composer(3),
            *js("(() => { const t = document.querySelector('#cards .card.composer textarea'); t.focus(); t.value = 'Not delivered note'; t.dispatchEvent(new Event('input', { bubbles: true })); "
                "window.__top = document.querySelector('#cards .card.composer').getBoundingClientRect().top; document.querySelector('#cards .card.composer [data-action=\"post\"]').click(); return true })()", LAND),
            C(f'{label}: an undelivered new comment stays at its text as Not sent, with Try again and Dismiss',
              "const c = [...document.querySelectorAll('#cards .card')].find((n) => vis(n) && n.textContent.includes('Not delivered note') && !n.classList.contains('composer')); "
              "return {ok: !!c && /not sent/i.test(c.textContent) && !!btn(c, 'Try again') && !!btn(c, 'Dismiss') && Math.abs(c.getBoundingClientRect().top - window.__top) < 40, top: c?.getBoundingClientRect().top, was: window.__top}"),
            {'shot': f'{label}-not-sent-new'},
            *js("(() => { %s const c = [...document.querySelectorAll('#cards .card')].find((n) => n.textContent.includes('Not delivered note')); btn(c, 'Dismiss').click(); return true })()" % H, 700),
            C(f'{label}: Dismiss removes it', "return {ok: ![...document.querySelectorAll('#cards .card')].some((n) => vis(n) && n.textContent.includes('Not delivered note'))}"),
        ]
    return steps


def page_shot(route, steps, width, theme, label):
    f = os.path.join(W, f'steps-{label}.json')
    json.dump(steps, open(f, 'w'))
    cmd = [os.path.expanduser('~/.local/bin/page-shot'), f'http://127.0.0.1:{PORT}{route}', '--out', os.path.join(OUT, 'shots'), '--widths', str(width),
           '--themes', theme, '--viewport-only', '--steps', f, '--timeout', '120']
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
    errors = [e for e in (out.get('console_errors') or []) if 'Content Security Policy' not in str(e)]
    check(f'{label}: no console errors', not errors, str(errors)[:600])
    print('shots:', out.get('dir'), flush=True)


def view():
    return json.loads(urllib.request.urlopen(f'http://127.0.0.1:{PORT}/w/api/live-scopes/demo').read())


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
        for width, theme in ((1280, 'light'), (390, 'dark')):
            urllib.request.urlopen(urllib.request.Request(f'http://127.0.0.1:{PORT}/__reset', data=b'{}', method='POST')).read()
            open(log, 'w').close()
            label = f'{width}-{theme}'
            page_shot('/scope/demo', scenario(width < 600, label), width, theme, label)
            posts = [e for e in (json.loads(l) for l in open(log) if l.strip()) if e['method'] == 'POST' and e['path'].startswith('/w/api/live-scopes/demo/threads')]
            resolves = [p for p in posts if p['path'].endswith('/T2/resolve')]
            check(f'{label}: one resolve of T2, as his own Resolve', len(resolves) == 1 and resolves[0]['body'].get('how') == 'resolve', [p['body'] for p in resolves])
            replies = [p for p in posts if p['path'].endswith('/T1/reply')]
            check(f'{label}: the undelivered reply was sent twice, the second time landed', len(replies) == 2 and any(m.get('text') == 'Reopen the plan' for t in view()['scope']['threads'] if t['id'] == 'T1' for m in t['messages']), [p['body'].get('text') for p in replies])
            reopens = [p for p in posts if p['path'].endswith('/T2/reopen')]
            check(f'{label}: T2 is open again after one Reopen', len(reopens) == 1 and next(t for t in view()['scope']['threads'] if t['id'] == 'T2')['status'] == 'open', len(reopens))
    finally:
        stub.terminate()


run()
bad = [r for r in results if not r[1]]
print(f'\n{len(results) - len(bad)}/{len(results)} passed')
sys.exit(1 if bad else 0)
