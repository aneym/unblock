#!/usr/bin/env python3
"""Browser e2e for live replies (owner: Opus, explainers lane for w5H:p0M, 2026-10-03; implementers make it pass, never edit it).

Alex (2026-10-03): "would be cool if i could see your responses streaming in the comments and a thinking indicator";
"the 'ready by factory' can just be an eye emoji reaction to my latest message, then the thinking indicator";
"it'd be good to know how this comment is being handled ... we work on comments one at a time ... chronologically".
Serves web/dist-scope from e2e/scope-stub.mjs (port 4629), whose /__stream_reply plays the daemon's live item frames for
one lane turn on T2: seen, thinking, thinking "Reading FINDINGS.md", five growing chunks, done, then the reply message.
At 1280, light, a 40 ms sampler on the page shows, with no reload: a small 👀 on Alex's message titled "Seen by Rooms PM"
no later than the thinking line; the thinking line ("Thinking", then the activity "Reading FINDINGS.md"); the text growing
in place; then the reply standing as a normal message with no live block left and the 👀 still there. While T2 is being
answered, T3 and T4 (also waiting on the lane) say "Next" and "After T3". A lane read receipt shows as 👀 "Seen by <name>",
never as a "Read by" line.
usage: e2e/scope-live.e2e.py [<worktree>] [--no-build]
"""
import json, os, shutil, subprocess, sys, time, urllib.request

E = os.path.dirname(os.path.abspath(__file__))
WT = os.path.abspath(next((a for a in sys.argv[1:] if not a.startswith("--")), os.path.join(E, "..")))
DIST = os.path.join(WT, 'web', 'dist-scope')
OUT = os.environ.get('E2E_OUT') or os.path.join(os.environ.get('TMPDIR', '/tmp'), 'unblock-e2e')
W = os.path.join(OUT, f'work-{os.path.basename(__file__)}')
PORT = 4629
results = []


def check(name, ok, detail=''):
    results.append((name, bool(ok), detail))
    print(('PASS ' if ok else 'FAIL ') + name + (f' — {detail}' if detail and not ok else ''), flush=True)


def C(name, js):
    return {'eval': f"(() => {{ try {{ const r = (() => {{ {js} }})(); return {{check: {json.dumps(name)}, ok: !!(r && r.ok !== undefined ? r.ok : r), detail: r}} }} catch (e) {{ return {{check: {json.dumps(name)}, ok: false, detail: String(e)}} }} }})()"}


def hook(q):
    return [{'eval': "fetch('/__%s').then((r) => r.json()).then(({seq}) => new Promise((done) => { const t0 = Date.now(); const tick = () => (document.body.textContent.includes(`revision ${seq}`) || document.querySelector('#title .meta')?.textContent.includes(`Revision ${seq} `) || Date.now() - t0 > 8000) ? done(seq) : setTimeout(tick, 100); tick() }))" % q}, {'wait': 600}]


SAMPLER = """(() => {
  window.__tl = []
  const card = (t) => [...document.querySelectorAll(`#cards .card[data-t="${t}"], #detached .card[data-t="${t}"]`)].find((n) => n.getClientRects().length)
  window.__sampler = setInterval(() => {
    const c = card('T2'), live = c?.querySelector('.live'), th = c?.querySelector('.thinking')
    window.__tl.push({ eyes: c?.querySelector('.reaction')?.getAttribute('title') || null, thinking: !!th, doing: th?.textContent.trim() || null,
      live: !!live, text: live?.querySelector('.live-text')?.textContent.trim() || '',
      final: [...(c?.querySelectorAll('.msg:not(.live)') || [])].some((m) => m.textContent.includes('then voice rides on it.')),
      q3: card('T3')?.querySelector('.queue-place')?.textContent.trim() || null, q4: card('T4')?.querySelector('.queue-place')?.textContent.trim() || null })
  }, 40)
  return true
})()"""
TL = "const tl = window.__tl || []; "


def scenario(label):
    steps = [{'wait_for': 'mark.hl[data-t="T2"]'}, {'wait': 800}, {'click': '#cards .card[data-t="T2"] .q'}, {'wait': 900},
             {'eval': SAMPLER}, {'eval': "fetch('/__stream_reply?thread=T2&by=Rooms%20PM').then((r) => r.ok)"}, {'wait': 5200},
             {'eval': "(() => { clearInterval(window.__sampler); return (window.__tl || []).length })()"}]
    steps.append(C(f'{label}: no reload (the sampler survived the whole turn)', TL + "return {ok: tl.length > 60 && performance.getEntriesByType('navigation').length === 1, n: tl.length}"))
    steps.append(C(f'{label}: 👀 "Seen by Rooms PM" shows on his message no later than the thinking line',
                   TL + "const e = tl.findIndex((s) => s.eyes === 'Seen by Rooms PM'), th = tl.findIndex((s) => s.thinking); return {ok: e >= 0 && th >= 0 && e <= th, e, th}"))
    steps.append(C(f'{label}: the thinking line says Thinking, then the activity',
                   TL + "const a = tl.findIndex((s) => s.thinking && /^Thinking/.test(s.doing || '')), b = tl.findIndex((s) => s.thinking && (s.doing || '').includes('Reading FINDINGS.md')); return {ok: a >= 0 && b > a, a, b}"))
    steps.append(C(f'{label}: the reply text grows in place in at least three steps',
                   TL + "const seen = []; for (const s of tl) if (s.live && s.text && s.text !== seen.at(-1)) seen.push(s.text); return {ok: seen.length >= 3 && seen.every((t, i) => !i || (t.startsWith(seen[i - 1]) && t.length > seen[i - 1].length)), seen}"))
    steps.append(C(f'{label}: the activity line goes once text streams with nothing else going on',
                   TL + "const s = tl.filter((x) => x.live && x.text && !x.final).at(-1); return {ok: !!s && !s.thinking, s}"))
    steps.append(C(f'{label}: done: the reply stands as a normal message, no live block or thinking line left, the 👀 stays',
                   TL + "const s = tl.at(-1); return {ok: !!s && s.final && !s.live && !s.thinking && s.eyes === 'Seen by Rooms PM', s}"))
    steps.append(C(f'{label}: while T2 is answered, T3 and T4 show their place in the queue',
                   TL + "const s = tl.find((x) => (x.thinking || x.live) && x.q3 === 'Next' && x.q4 === 'After T3'); return {ok: !!s, sample: tl.find((x) => x.thinking || x.live)}"))
    steps.append(C(f'{label}: no "Read by" or "Seen" chip on any card',
                   "const t = [...document.querySelectorAll('.card .delivery-chip')].map((n) => n.textContent); return {ok: !t.some((x) => /Read by|Seen/.test(x)), t}"))
    steps += hook('note?thread=T3&delivery=delivered&read_by=Scope%20PM')
    steps.append(C(f'{label}: a lane read receipt is a 👀 "Seen by Scope PM", not a Read by line',
                   "const c = [...document.querySelectorAll('#cards .card[data-t=\"T3\"]')].find((n) => n.getClientRects().length); return {ok: c?.querySelector('.reaction')?.getAttribute('title') === 'Seen by Scope PM' && !/Read by/.test(c.textContent), text: c?.textContent.slice(0, 160)}"))
    steps.append(C(f'{label}: no page error', "const e = window.__errs || []; return {ok: e.length === 0, e}"))
    return steps


def page_shot(steps, width, label):
    f = os.path.join(W, f'steps-{label}.json')
    json.dump(steps, open(f, 'w'))
    cmd = [os.path.expanduser('~/.local/bin/page-shot'), f'http://127.0.0.1:{PORT}/scope/demo', '--out', os.path.join(OUT, 'shots-live'),
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
        for width in (1280,):
            urllib.request.urlopen(f'http://127.0.0.1:{PORT}/__reset').read()
            page_shot(scenario(f'{width}'), width, f'{width}')
    finally:
        stub.terminate()


run()
bad = [r for r in results if not r[1]]
print(f'\n{len(results) - len(bad)}/{len(results)} passed')
sys.exit(1 if bad else 0)
