#!/usr/bin/env python3
"""Browser e2e for the pinned view (owner: Opus, explainers lane for w5H:p0M, 2026-10-03; implementers make it pass, never edit it).

Alex (2026-10-03): "when scoping docs change, the comment i have open gets collapsed or something, i need the comment
scroll and location to stay pinned on my screen, even if the content moves, since i'm likely waiting for your response."
And: "when i click a comment that's already expanded, we dont need to rescroll to its anchor".
Serves web/dist-scope from e2e/scope-stub.mjs (port 4628). At 1280, light: Alex opens T2 and types a draft; the lane
adds ten paragraphs above T2's anchor. T2's card keeps its screen position (2 px), stays open, and keeps the draft and the
focus. Clicking the open card does not scroll. When T2's quote leaves the doc, the open card stays where it was, keeps the
draft, and says "Section changed". At 390 (touch) the open sheet survives the same update with its draft and focus.
usage: e2e/scope-pinned.e2e.py [<worktree>] [--no-build]
"""
import json, os, shutil, subprocess, sys, time, urllib.request

E = os.path.dirname(os.path.abspath(__file__))
WT = os.path.abspath(next((a for a in sys.argv[1:] if not a.startswith("--")), os.path.join(E, "..")))
DIST = os.path.join(WT, 'web', 'dist-scope')
OUT = os.environ.get('E2E_OUT') or os.path.join(os.environ.get('TMPDIR', '/tmp'), 'unblock-e2e')
W = os.path.join(OUT, f'work-{os.path.basename(__file__)}')
PORT = 4628
results = []


def check(name, ok, detail=''):
    results.append((name, bool(ok), detail))
    print(('PASS ' if ok else 'FAIL ') + name + (f' — {detail}' if detail and not ok else ''), flush=True)


def C(name, js):
    return {'eval': f"(() => {{ try {{ const r = (() => {{ {js} }})(); return {{check: {json.dumps(name)}, ok: !!(r && r.ok !== undefined ? r.ok : r), detail: r}} }} catch (e) {{ return {{check: {json.dumps(name)}, ok: false, detail: String(e)}} }} }})()"}


def hook(q):
    return [{'eval': "fetch('/__%s').then((r) => r.json()).then(({seq}) => new Promise((done) => { const t0 = Date.now(); const tick = () => (document.body.textContent.includes(`revision ${seq}`) || document.querySelector('#title .meta')?.textContent.includes(`Revision ${seq} `) || Date.now() - t0 > 8000) ? done(seq) : setTimeout(tick, 100); tick() }))" % q}, {'wait': 600}]


CARD = "document.querySelector('#cards .card[data-t=\\\"T2\\\"]')"
DRAFT = 'my draft, still typing'


def desktop(label):
    card = '#cards .card[data-t="T2"]'
    steps = [{'wait_for': 'mark.hl[data-t="T2"]'}, {'wait': 800},
             {'click': f'{card} .q'}, {'wait': 1200},
             {'fill': [f'{card} textarea[data-draft="T2"]', DRAFT]},
             {'eval': f"(() => {{ const c = {CARD}; window.__top = c.getBoundingClientRect().top; window.__y0 = scrollY; window.__m0 = document.querySelector('mark.hl[data-t=\"T2\"]').getBoundingClientRect().top + scrollY; return window.__top }})()"}]
    steps += hook('grow_plan')
    steps.append(C(f'{label}: the open card keeps its screen position when 800 px land above its anchor',
                   f"const c = {CARD}; const top = c && c.getBoundingClientRect().top; return {{ok: !!c && Math.abs(top - window.__top) <= 2, top, was: window.__top}}"))
    # The anchor's text moved 600+ px down the document; the page scrolls less than that when the card was
    # stacked below its text before the update and sits on it after (cards stay on their text, ceb1683).
    steps.append(C(f'{label}: the content above really grew (the anchor moved down and the page scrolled to hold the card)',
                   "const m = document.querySelector('mark.hl[data-t=\\\"T2\\\"]').getBoundingClientRect().top + scrollY; return {ok: m - window.__m0 > 600 && scrollY - window.__y0 > 200, moved: m - window.__m0, scrolled: scrollY - window.__y0}"))
    steps.append(C(f'{label}: the open card stays open', f"return {{ok: !!{CARD}?.classList.contains('on')}}"))
    steps.append(C(f'{label}: the draft and the focus survive',
                   f"const ta = {CARD}?.querySelector('textarea[data-draft=\"T2\"]'); return {{ok: ta?.value === {DRAFT!r} && document.activeElement === ta, value: ta?.value, active: document.activeElement?.tagName}}"))
    steps.append({'eval': "(() => { window.__y1 = scrollY; return scrollY })()"})
    steps += [{'click': f'{card} .q'}, {'wait': 1000}]
    steps.append(C(f'{label}: clicking the open card does not scroll', "return {ok: Math.abs(scrollY - window.__y1) <= 1, moved: scrollY - window.__y1}"))
    steps.append({'eval': "(() => { const c = [...document.querySelectorAll('.card[data-t=\"T2\"]')].find((n) => n.getClientRects().length); window.__top2 = c.getBoundingClientRect().top; return window.__top2 })()"})
    steps += hook('detach_t2')
    steps.append(C(f'{label}: when its text leaves the doc, the open card stays put, keeps the draft and says "Section changed"',
                   "const c = [...document.querySelectorAll('.card[data-t=\"T2\"]')].find((n) => n.getClientRects().length); const top = c && c.getBoundingClientRect().top; "
                   f"return {{ok: !!c && Math.abs(top - window.__top2) <= 2 && /Section changed/.test(c.textContent) && c.querySelector('textarea')?.value === {DRAFT!r}, top, was: window.__top2, text: c?.textContent.slice(0, 160)}}"))
    steps.append(C(f'{label}: no page error', "const e = window.__errs || []; return {ok: e.length === 0, e}"))
    return steps


def phone(label):
    steps = [{'wait_for': 'mark.hl[data-t="T2"]'}, {'wait': 800}, {'tap': 'mark.hl[data-t="T2"]'}, {'wait': 900},
             {'fill': ['.sheet textarea[data-draft="T2"]', DRAFT]}]
    steps += hook('grow_plan')
    steps.append(C(f'{label}: the open sheet survives the update with its draft and focus',
                   f"const ta = document.querySelector('.sheet textarea[data-draft=\"T2\"]'); return {{ok: document.body.classList.contains('sheet-open') && ta?.value === {DRAFT!r} && document.activeElement === ta, open: document.body.classList.contains('sheet-open'), value: ta?.value}}"))
    steps.append(C(f'{label}: no page error', "const e = window.__errs || []; return {ok: e.length === 0, e}"))
    return steps


def scenario(label):
    return phone(label) if label == '390' else desktop(label)


def page_shot(steps, width, label):
    f = os.path.join(W, f'steps-{label}.json')
    json.dump(steps, open(f, 'w'))
    cmd = [os.path.expanduser('~/.local/bin/page-shot'), f'http://127.0.0.1:{PORT}/scope/demo', '--out', os.path.join(OUT, 'shots-pinned'),
           '--widths', str(width), '--themes', 'light', '--viewport-only', '--steps', f, '--timeout', '60']
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
    print('shots:', out.get('dir'), flush=True)


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
    stub = subprocess.Popen(['node', os.path.join(E, 'scope-stub.mjs'), str(PORT), WT, DIST, log, 'solo'],
                            stdout=open(os.path.join(W, f'stub-{PORT}.out'), 'w'), stderr=subprocess.STDOUT)
    try:
        for _ in range(50):
            try:
                urllib.request.urlopen(f'http://127.0.0.1:{PORT}/scope/demo').read()
                break
            except Exception:
                time.sleep(0.2)
        for width in (1280, 390):
            urllib.request.urlopen(f'http://127.0.0.1:{PORT}/__reset').read()
            page_shot(scenario(f'{width}'), width, f'{width}')
    finally:
        stub.terminate()


run()
bad = [r for r in results if not r[1]]
print(f'\n{len(results) - len(bad)}/{len(results)} passed')
sys.exit(1 if bad else 0)
