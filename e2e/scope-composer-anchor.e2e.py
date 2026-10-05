#!/usr/bin/env python3
"""Regression e2e: other comment cards stay at their anchors while the new-comment composer is open
(owner: Opus; implementers make it pass, never edit it).

Alex (2026-10-03 ~17:55 ET): "sometimes when i'm writing a comment, all the other comments get grouped into view and
when i submit they go back anchored to where they're supposed to be? fix".
Serves web/dist-scope from scope-stub.mjs (port 4598) with eight more threads spread down the Later section
(lane questions and Alex's notes). At 1280, light and dark, it selects text in Later paragraph 13 near the bottom of
the viewport, opens the composer with a right-click, and proves:
  0) before the composer opens, cards on Later sit at their text (the crowd of cards at the top does not shift them);
  1) right after the composer opens, every other card keeps its top within 12px of where it sat before, unless at its
     old place it would overlap the composer (or a card that had to move for it), and the composer sits at its text;
  2) the same holds after the page redraws while he types (a lane reaction arrives over the stream), and no card is
     stacked against the composer away from its own text;
  3) after he posts, every other card is back within 12px of its first place (the new card may nudge its neighbours);
  4) Alex (18:0x ET): "comments ... seem to be collapsing still when page reloads or something hot because we changed
     the doc?": after a reload, and after the lane edits Later and then the plan over the stream, every card sits at its
     text or is nudged off it only by the neighbour it would overlap, in text order, with Resolved on (resolved cards
     included), and after a thread resolves live.
usage: e2e/scope-composer-anchor.e2e.py <worktree> [--no-build]
"""
import json, os, shutil, subprocess, sys, time, urllib.request

E = os.path.dirname(os.path.abspath(__file__))
WT = os.path.abspath(next((a for a in sys.argv[1:] if not a.startswith("--")), os.path.join(E, "..")))
DIST = os.path.join(WT, 'web', 'dist-scope')
OUT = os.environ.get('E2E_OUT') or os.path.join(os.environ.get('TMPDIR', '/tmp'), 'unblock-e2e')
W = os.path.join(OUT, f'work-{os.path.basename(__file__)}')
PORT = 4598
results = []


def check(name, ok, detail=''):
    results.append((name, bool(ok), detail))
    print(('PASS ' if ok else 'FAIL ') + name + (f' — {detail}' if detail and not ok else ''), flush=True)


def C(name, js):
    return {'eval': f"(() => {{ try {{ const r = (() => {{ {js} }})(); return {{check: {json.dumps(name)}, ok: !!(r && r.ok !== undefined ? r.ok : r), detail: r}} }} catch (e) {{ return {{check: {json.dumps(name)}, ok: false, detail: String(e)}} }} }})()"}


def js(code, wait=600):
    return [{'eval': code}, {'wait': wait}]


def hook_steps(q):
    return [{'eval': "fetch('/__%s').then((r) => r.json()).then(({seq}) => new Promise((done) => { const t0 = Date.now(); const tick = () => (document.querySelector('#title .meta')?.textContent.includes(`Revision ${seq} `) || document.body.textContent.includes(`revision ${seq}`) || Date.now() - t0 > 8000) ? done(seq) : setTimeout(tick, 100); tick() }))" % q}, {'wait': 600}]


NO_ERRORS = "const e = window.__errs || []; const csp = (window.__csp || []).filter((x) => x.startsWith('script') || x.startsWith('img')); return {ok: e.length === 0 && csp.length === 0, e, csp}"
# pos(): every rail card's top and height in rail coordinates (style.top, so scrolling does not move it) and the top of
# its first highlight in the same coordinates. A redraw can move the text (the lane's "working" line under the title
# pushes the doc down), and a card should move with its text; a card crowded off its text may stay put. So off(b, n)
# is how far the card's move falls outside [0, how far its text moved], or 0 when the card now sits at its text.
# moved(before, now, obstacle): cards with off > 12 unless, at their old place, they would overlap the obstacle (the
# composer or the new card), a card sitting at its text, or a card that itself had to move, and they moved no further
# than the two cards' heights: a nudge, not a trip to the other end of the rail.
# stacked(before, now): cards packed edge to edge directly above the composer that also left their place.
X = ("const rail = () => document.querySelector('#cards').getBoundingClientRect().top; "
     "const pos = () => Object.fromEntries([...document.querySelectorAll('#cards > .card')].map((n) => { const m = n.dataset.t && document.querySelector(`mark.hl[data-t=\"${n.dataset.t}\"]`); "
     "return [n.classList.contains('composer') ? 'composer' : n.dataset.t || 'sending', { top: parseFloat(n.style.top), h: n.offsetHeight, mark: m ? m.getBoundingClientRect().top - rail() : null }] })); "
     "const home = (n) => n.mark != null && Math.abs(n.top - (n.mark - 12)) <= 12; "
     "const shift = (b, n) => b.mark == null || n.mark == null ? 0 : n.mark - b.mark; "
     "const off = (b, n) => { const d = n.top - b.top, s = shift(b, n); return home(n) ? 0 : Math.max(0, Math.min(0, s) - d, d - Math.max(0, s)) }; "
     "const was = (b, n) => b.top + shift(b, n); "
     "const moved = (before, now, obstacle) => { const ids = Object.keys(before).filter((id) => id !== 'composer' && now[id]).sort((a, b) => before[a].top - before[b].top); "
     "const blockers = [now[obstacle], ...ids.filter((id) => home(now[id])).map((id) => now[id])].filter(Boolean), allowed = new Set(); let grew = true; "
     "while (grew) { grew = false; for (const id of ids) { const b = before[id], n = now[id], t = was(b, n); if (allowed.has(id) || off(b, n) <= 12) continue; "
     "if (blockers.some((o) => o !== n && t < o.top + o.h + 10 && o.top < t + b.h + 10 && Math.abs(n.top - t) <= b.h + o.h + 20)) { allowed.add(id); blockers.push(n); grew = true } } } "
     "return ids.filter((id) => off(before[id], now[id]) > 12 && !allowed.has(id)).map((id) => ({ id, was: Math.round(was(before[id], now[id])), now: Math.round(now[id].top) })) }; "
     "const stacked = (before, now) => { const c = now.composer; if (!c) return []; const out = []; let edge = c.top; "
     "for (const id of Object.keys(now).filter((id) => id !== 'composer').sort((a, b) => now[b].top - now[a].top)) { const n = now[id]; if (n.top >= c.top) continue; "
     "if (Math.abs(n.top + n.h + 10 - edge) <= 2) { if (before[id] && off(before[id], n) > 12) out.push({ id, was: Math.round(was(before[id], n)), now: Math.round(n.top) }); edge = n.top } else break } return out }; "
     "const selTop = () => { const r = window.__range; return r ? r.getBoundingClientRect().top - rail() : null }; "
     # settled(): every card is at its text (top = highlight - 12, within 12px) or was nudged off it by the minimum, i.e.
     # it sits edge to edge against the card above (pushed down) or below (pushed up), and a card is only pushed down by a
     # card whose text is above its own. A whole-rail shift, a pile-up or cards out of text order fail.
     "const settled = () => { const p = pos(), list = Object.entries(p).sort((a, b) => a[1].top - b[1].top); "
     "return list.filter(([id, c], i) => { if (c.mark == null) return true; const want = c.mark - 12, prev = list[i - 1]?.[1], next = list[i + 1]?.[1]; "
     "if (Math.abs(c.top - want) <= 12) return false; if (c.top > want && (prev ? Math.abs(prev.top + prev.h + 10 - c.top) <= 2 && (prev.mark == null || prev.mark <= c.mark + 2) : c.top <= 8)) return false; "
     "if (c.top < want && next && Math.abs(c.top + c.h + 10 - next.top) <= 2) return false; return true }).map(([id, c]) => ({ id, top: Math.round(c.top), text: Math.round(c.mark) })) };")
PARA = "[...document.querySelectorAll('#later p')].find((p) => p.textContent.startsWith('Later paragraph 13:'))"


def scenario(label):
    open_composer = js(
        "(() => { const p = %s; p.scrollIntoView({ block: 'end' }); scrollBy(0, 80); const t = p.firstChild, i = t.textContent.indexOf('wait for pass 13'); "
        "const r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + 'wait for pass 13'.length); const s = getSelection(); s.removeAllRanges(); s.addRange(r); window.__range = r.cloneRange(); "
        "const box = r.getClientRects()[0]; const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: box.left + 4, clientY: box.top + box.height / 2, button: 2 }); "
        "p.dispatchEvent(ev); return ev.defaultPrevented })()" % PARA, 900)
    return [
        {'wait_for': 'mark.hl[data-t="T2"]'},
        {'wait': 400},
        *hook_steps('spread'),
        {'wait_for': '#cards .card[data-t="T12"]'},
        {'wait': 600},
        # Before: scroll Later paragraph 13 near the bottom, let the rail settle, record every card.
        *js("(() => { const p = %s; p.scrollIntoView({ block: 'end' }); scrollBy(0, 80); return true })()" % PARA, 700),
        C(f'{label}: fixture has twelve cards in the rail', X + " window.__before = pos(); const n = Object.keys(window.__before).length; return {ok: n === 12, n}"),
        # The four cards on the title and the plan crowd the top of the rail; that crowd may push its own cards down,
        # but it must not shift the cards on Later, whose text is far below it.
        C(f'{label}: with no composer, cards on Later sit at their text', X + " const p = window.__before, bad = Object.entries(p).filter(([id, c]) => Number(id.slice(1)) >= 5 && Math.abs(c.top - (c.mark - 12)) > 12 && !Object.values(p).some((o) => o !== c && c.mark - 12 < o.top + o.h + 10 && o.top < c.mark - 12 + c.h + 10)).map(([id, c]) => ({ id, top: Math.round(c.top), text: Math.round(c.mark) })); return {ok: bad.length === 0, bad}"),
        *open_composer,
        C(f'{label}: right-click on the selection opens the composer', X + " const c = document.querySelector('#cards .card.composer'); return {ok: !!c && document.activeElement === c.querySelector('textarea')}"),
        C(f'{label}: the composer sits at its selected text', X + " const c = pos().composer, s = selTop(); return {ok: !!c && Math.abs(c.top - s) <= 12, composer: c && Math.round(c.top), selection: Math.round(s)}"),
        C(f'{label}: when the composer opens, other cards stay at their anchors', X + " const bad = moved(window.__before, pos(), 'composer'); return {ok: bad.length === 0, bad}"),
        {'shot': f'{label}-composer-open'},
        # He types; a lane reaction arrives over the stream and the page redraws the rail.
        *js("(() => { const t = document.querySelector('#cards .card.composer textarea'); t.value = 'Pass 13 needs fonts too.'; t.dispatchEvent(new Event('input', { bubbles: true })); return true })()", 300),
        *hook_steps('react?thread=T1'),
        C(f'{label}: after a redraw while typing, the composer still sits at its selected text', X + " const c = pos().composer, s = selTop(); return {ok: !!c && Math.abs(c.top - s) <= 12, composer: c && Math.round(c.top), selection: Math.round(s)}"),
        C(f'{label}: after a redraw while typing, other cards stay at their anchors', X + " const bad = moved(window.__before, pos(), 'composer'); return {ok: bad.length === 0, bad}"),
        C(f'{label}: no card is stacked against the composer away from its text', X + " const bad = stacked(window.__before, pos()); return {ok: bad.length === 0, bad}"),
        C(f'{label}: the draft survived the redraw', "const t = document.querySelector('#cards .card.composer textarea'); return {ok: t?.value === 'Pass 13 needs fonts too.' && document.activeElement === t, value: t?.value}"),
        {'shot': f'{label}-composer-after-redraw'},
        # He posts; the new thread is T13.
        *js("(() => { document.querySelector('#cards .card.composer [data-action=\"post\"]').click(); return true })()", 1800),
        {'wait_for': '#cards .card[data-t="T13"]'},
        {'wait': 600},
        C(f'{label}: after posting, other cards are back at their anchors', X + " const bad = moved(window.__before, pos(), 'T13'); return {ok: bad.length === 0, bad}"),
        {'shot': f'{label}-posted'},
        # Alex (18:0x ET): "comments ... seem to be collapsing still when page reloads or something hot because we changed the doc?"
        # His rails-rooms scope has 26 resolved threads; with Resolved on (it persists across reloads) they show in the rail.
        # Alex takes the lane's pick on T8 (Later paragraph 8) and an old resolved note sits on the plan (T14).
        *hook_steps('alex_take?thread=T8'),
        *hook_steps('old_resolved'),
        *js("(() => { const t = document.querySelector('#showResolved'); if (t && !t.checked) t.click(); return !!t })()", 700),
        C(f'{label}: with Resolved on, every card sits at its text or is nudged by a neighbour', X + " const bad = settled(); return {ok: bad.length === 0, bad}"),
        # (a) Reload with the same threads.
        *js("(() => { setTimeout(() => location.reload(), 50); return true })()", 400),
        {'wait_for': '#cards .card[data-t="T14"]'},
        {'wait': 300},
        C(f'{label}: right after a reload, every card sits at its text or is nudged by a neighbour', X + " const bad = settled(); return {ok: bad.length === 0, bad}"),
        {'wait': 2000},
        C(f'{label}: once a reload settles, every card sits at its text or is nudged by a neighbour', X + " const bad = settled(); return {ok: bad.length === 0, bad}"),
        {'shot': f'{label}-reloaded'},
        # (b) The lane edits the doc: paragraph 16 of Later (T12's text, the quote still matches), then the plan (T4's).
        C(f'{label}: record the rail before the lane edits', X + " window.__live = pos(); return true"),
        *hook_steps('edit_later'),
        C(f'{label}: after the lane edits Later, the edited thread keeps its highlight', "return {ok: !!document.querySelector('mark.hl[data-t=\"T12\"]')}"),
        C(f'{label}: after the lane edits Later, every card sits at its text or is nudged by a neighbour', X + " const bad = settled(); return {ok: bad.length === 0, bad}"),
        C(f'{label}: after the lane edits Later, no card left its place', X + " const bad = moved(window.__live, pos(), null); return {ok: bad.length === 0, bad}"),
        *hook_steps('lane_edit'),
        {'wait': 1500},
        C(f'{label}: after the lane edits the plan, every card sits at its text or is nudged by a neighbour', X + " const bad = settled(); return {ok: bad.length === 0, bad}"),
        {'shot': f'{label}-lane-edited'},
        # The lane's pick on T10 is taken live while Resolved is on: its card stays by its text.
        *hook_steps('alex_take?thread=T10'),
        C(f'{label}: after a thread resolves live, every card sits at its text or is nudged by a neighbour', X + " const bad = settled(); return {ok: bad.length === 0, bad}"),
        C(f'{label}: no page error', NO_ERRORS),
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
    errors = [e for e in (out.get('console_errors') or []) if 'Content Security Policy' not in str(e) or 'script' in str(e) or 'img' in str(e)]
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
    stub = subprocess.Popen(['node', os.path.join(E, 'scope-stub.mjs'), str(PORT), WT, DIST, log, 'solo'], stdout=open(os.path.join(W, f'stub-{PORT}.out'), 'w'), stderr=subprocess.STDOUT)
    try:
        for _ in range(50):
            try:
                urllib.request.urlopen(f'http://127.0.0.1:{PORT}/scope/demo').read()
                break
            except Exception:
                time.sleep(0.2)
        for theme in ('light', 'dark'):
            reset(log)
            label = f'1280-{theme}'
            page_shot('/scope/demo', scenario(label), 1280, theme, label)
            posts = [e for e in (json.loads(l) for l in open(log) if l.strip()) if e['method'] == 'POST' and e['path'] == '/w/api/live-scopes/demo/threads']
            check(f'{label}: one new comment posted, on the selected text', len(posts) == 1 and posts[0]['body']['anchor']['quote'] == 'wait for pass 13', [p['body'].get('anchor') for p in posts])
    finally:
        stub.terminate()


run()
bad = [r for r in results if not r[1]]
print(f'\n{len(results) - len(bad)}/{len(results)} passed')
sys.exit(1 if bad else 0)
