#!/usr/bin/env python3
"""Browser e2e for scope-sending-stale: a comment says where it went (owner: Opus; implementers make it pass, never edit it).

Alex (2026-10-01 07:53 ET, chatgpt-utility-apps): "scoping sending still seems to not be actually working to the right agent".
The page said "Sent" for a note that had only been queued, and never showed that the PM got it. Serves web/dist-scope from
e2e/scope-stub.mjs (port 4627). At 1280 and 390, light, the chip on Alex's comment T2 reads:
  1) "Sending…" while the daemon still holds the note (queued or held);
  2) "Sent" once lane-post took it (delivered);
  3) "Read by Scope PM" once the lane's hook took the bulletin (delivered, read_by "Scope PM");
and the in-flight summary line ("N comments · …") counts it as "1 Read".
usage: e2e/scope-read-by.e2e.py [<worktree>] [--no-build]
"""
import json, os, shutil, subprocess, sys, time, urllib.request

E = os.path.dirname(os.path.abspath(__file__))
WT = os.path.abspath(next((a for a in sys.argv[1:] if not a.startswith("--")), os.path.join(E, "..")))
DIST = os.path.join(WT, 'web', 'dist-scope')
OUT = os.environ.get('E2E_OUT') or os.path.join(os.environ.get('TMPDIR', '/tmp'), 'unblock-e2e')
W = os.path.join(OUT, f'work-{os.path.basename(__file__)}')
PORT = 4627
results = []


def check(name, ok, detail=''):
    results.append((name, bool(ok), detail))
    print(('PASS ' if ok else 'FAIL ') + name + (f' — {detail}' if detail and not ok else ''), flush=True)


def C(name, js):
    return {'eval': f"(() => {{ try {{ const r = (() => {{ {js} }})(); return {{check: {json.dumps(name)}, ok: !!(r && r.ok !== undefined ? r.ok : r), detail: r}} }} catch (e) {{ return {{check: {json.dumps(name)}, ok: false, detail: String(e)}} }} }})()"}


def hook(q):
    return [{'eval': "fetch('/__%s').then((r) => r.json()).then(({seq}) => new Promise((done) => { const t0 = Date.now(); const tick = () => (document.body.textContent.includes(`revision ${seq}`) || document.querySelector('#title .meta')?.textContent.includes(`Revision ${seq} `) || Date.now() - t0 > 8000) ? done(seq) : setTimeout(tick, 100); tick() }))" % q}, {'wait': 600}]


CHIP = ("const card = document.querySelector('#cards .card[data-t=\"T2\"], #detached .card[data-t=\"T2\"], .sheet .card[data-t=\"T2\"]'); "
        "const chip = card?.querySelector('.delivery-chip'); const text = chip?.textContent.trim() || '';")


def scenario(label):
    steps = [{'wait_for': 'mark.hl[data-t="T2"]'}, {'wait': 800}]
    for delivery, want in (('queued', 'Sending…'), ('held', 'Sending…'), ('delivered', 'Sent')):
        steps += hook(f'note?thread=T2&delivery={delivery}')
        steps.append(C(f'{label}: {delivery} reads "{want}"', CHIP + f" return {{ok: text === {json.dumps(want)}, text}}"))
    steps += hook('note?thread=T2&delivery=delivered&read_by=Scope%20PM')
    steps.append(C(f'{label}: read reads "Read by Scope PM"', CHIP + " return {ok: text === 'Read by Scope PM', text}"))
    steps.append(C(f'{label}: the in-flight summary counts it as read',
                   "const t = document.body.textContent; return {ok: /\\b1 Read\\b/.test(t), sample: t.match(/\\d+ comments? ·[^\\n]{0,80}/)?.[0]}"))
    steps.append(C(f'{label}: no page error', "const e = window.__errs || []; return {ok: e.length === 0, e}"))
    return steps


def page_shot(steps, width, label):
    f = os.path.join(W, f'steps-{label}.json')
    json.dump(steps, open(f, 'w'))
    cmd = [os.path.expanduser('~/.local/bin/page-shot'), f'http://127.0.0.1:{PORT}/scope/demo', '--out', os.path.join(OUT, 'shots-read-by'),
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
