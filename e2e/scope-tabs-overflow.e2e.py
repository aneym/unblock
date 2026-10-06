#!/usr/bin/env python3
"""Browser e2e: a wide tab strip or table never widens the doc column (owner: Opus, 2026-10-06).

Alex (2026-10-06 13:12 ET): "comments are overlapping the product demo". A 12-tab fence's nowrap tablist set the
min-content of `.doc .body`, an implicit auto grid column, and the doc grew to 888 px, under the comment margin.
Serves a scope bundle from e2e/scope-stub.mjs (port 4631), appends a 12-tab fence and a 9-column table to The plan
(/__wide_doc), and at 1280 and 390 checks: the page has no sideways scroll, every block in a doc body ends inside the doc column,
the doc column ends left of the comment margin, and the tab strip and the table scroll inside the column.
usage: e2e/scope-tabs-overflow.e2e.py [<worktree>] [--dist <bundle dir>] [--no-build]
  --dist serves another copy of the bundle (agent-rails app/admin_static/scope) and skips the build.
"""
import json, os, shutil, subprocess, sys, time, urllib.request

E = os.path.dirname(os.path.abspath(__file__))
ARGS = sys.argv[1:]
DIST_ARG = ARGS[ARGS.index('--dist') + 1] if '--dist' in ARGS else None
POS = [a for i, a in enumerate(ARGS) if not a.startswith('--') and (i == 0 or ARGS[i - 1] != '--dist')]
WT = os.path.abspath(POS[0] if POS else os.path.join(E, '..'))
DIST = os.path.abspath(DIST_ARG) if DIST_ARG else os.path.join(WT, 'web', 'dist-scope')
OUT = os.environ.get('E2E_OUT') or os.path.join(os.environ.get('TMPDIR', '/tmp'), 'unblock-e2e')
W = os.path.join(OUT, f'work-{os.path.basename(__file__)}')
PORT = 4631
results = []


def check(name, ok, detail=''):
    results.append((name, bool(ok), detail))
    print(('PASS ' if ok else 'FAIL ') + name + (f' — {detail}' if detail and not ok else ''), flush=True)


def C(name, js):
    return {'eval': f"(() => {{ try {{ const r = (() => {{ {js} }})(); return {{check: {json.dumps(name)}, ok: !!(r && r.ok !== undefined ? r.ok : r), detail: r}} }} catch (e) {{ return {{check: {json.dumps(name)}, ok: false, detail: String(e)}} }} }})()"}


RECTS = "const doc = document.querySelector('.doc').getBoundingClientRect(), side = document.querySelector('.side'), sideRect = side && side.getClientRects().length ? side.getBoundingClientRect() : null;"


def scenario(label):
    steps = [{'wait_for': '#doc h2'},
             {'eval': "fetch('/__wide_doc').then((r) => r.json())"},
             {'wait_for': '.scope-tabs [role="tab"]:nth-child(12)'},
             {'wait_for': '.doc .table-wrap table'},
             {'wait': 600}]
    steps.append(C(f'{label}: the page does not scroll sideways',
                   "const sw = document.documentElement.scrollWidth; return {ok: sw <= innerWidth, scrollWidth: sw, viewport: innerWidth}"))
    steps.append(C(f'{label}: every block in a doc body ends inside the doc column',
                   RECTS + " const over = [...document.querySelectorAll('.doc .body > *')].map((b) => [b.className || b.tagName, Math.round(b.getBoundingClientRect().right)]).filter(([, r]) => r > doc.right + 1); return {ok: over.length === 0, docRight: doc.right, over}"))
    steps.append(C(f'{label}: the doc column ends left of the comment margin (or the viewport when the margin is hidden)',
                   RECTS + " const limit = sideRect ? sideRect.left : innerWidth; return {ok: doc.right <= limit, docRight: doc.right, docWidth: doc.width, limit, margin: !!sideRect}"))
    steps.append(C(f'{label}: the 12-tab strip scrolls inside the column',
                   RECTS + " const t = document.querySelector('.scope-tabs [role=\"tablist\"]'), r = t.getBoundingClientRect(); return {ok: t.children.length === 12 && t.scrollWidth > t.clientWidth && r.right <= doc.right + 1, tabs: t.children.length, scrollWidth: t.scrollWidth, clientWidth: t.clientWidth, right: r.right, docRight: doc.right}"))
    steps.append(C(f'{label}: the wide table scrolls inside the column',
                   RECTS + " const w = document.querySelector('.doc .table-wrap'), r = w.getBoundingClientRect(); return {ok: w.scrollWidth > w.clientWidth && r.right <= doc.right + 1, scrollWidth: w.scrollWidth, clientWidth: w.clientWidth, right: r.right}"))
    steps += [{'eval': "(() => { document.querySelector('.scope-tabs').scrollIntoView({block: 'start'}); scrollBy(0, -80); return scrollY })()"},
              {'wait': 400}, {'shot': f'tabs-{label}'}]
    return steps


def page_shot(steps, width, label):
    f = os.path.join(W, f'steps-{label}.json')
    json.dump(steps, open(f, 'w'))
    # page-shot runs through python3 rather than its shebang (2026-10-06 Studio incident: shebang scripts hung at dyld).
    cmd = ['python3', os.path.expanduser('~/.local/bin/page-shot'), f'http://127.0.0.1:{PORT}/scope/demo', '--out', os.path.join(OUT, 'shots-tabs-overflow'),
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
    if '--no-build' not in ARGS and not DIST_ARG:
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
