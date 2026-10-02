#!/usr/bin/env python3
"""Browser e2e for rpt_83ad547f59e62008 and p6's scope-approve-missing (owner: Opus, 2026-10-01; implementers make it pass, never edit it).

Alex (2026-10-01 07:48 ET, in Rails Admin on route scoping/recruiter-messages): "rails is laggy. cmd + enter on a scoping
note doesnt reliably work. fix this". His ⌘Enter rule (09-30 09:55 ET): "if i do cmd enter with no comment, we can take
that as 'take it' and with a comment, we should use the context of the comment to decide". p6 (08:05 ET): "Alex can't
approve any scope from Admin ... Until it's live, have scope pages fall back to drawing Approve themselves in host mode."
Serves web/dist-scope from e2e/scope-admin-stub.mjs in admin mode (events off, the page polls; approve and comment host),
port 4619. At 1280 and 390 it proves:
  1) Alex, 2026-10-02 19:45 ET, superseding the ⌘Enter-picks rule above: "if i leave a comment, it should default to
     reply ... with just an approve button, if i dont need to comment". A note plus ⌘Enter on a lane question posts one
     plain reply, never asks the picker and never decides; the card stays open with Approve;
  2) ⌘Enter with no note sends nothing;
  3) Approve with a typed note takes the recommendation once, with his note as his words;
  4) an envelope-only change (each scopes push) does not redraw the doc or steal his reply box; a real lane edit still lands;
  5) Approve scope shows on a host-mode page that no host draws for: unframed, or framed by a page whose iframe lacks
     data-approve-host="1"; it does not show when the frame carries data-approve-host="1".
usage: e2e/scope-admin-cmdenter.e2e.py [worktree] [--no-build]
"""
import json, os, shutil, subprocess, sys, time, urllib.request

E = os.path.dirname(os.path.abspath(__file__))
WT = os.path.abspath(next((a for a in sys.argv[1:] if not a.startswith("--")), os.path.join(E, "..")))
DIST = os.path.join(WT, 'web', 'dist-scope')
OUT = os.environ.get('E2E_OUT') or os.path.join(os.environ.get('TMPDIR', '/tmp'), 'unblock-e2e')
W = os.path.join(OUT, f'work-{os.path.basename(__file__)}')
PORT = 4619
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
    ) % VISIBLE


def js(code, wait=600):
    return [{'eval': code}, {'wait': wait}]


def hook(q, wait=2600):
    """A stub hook; admin mode polls every 2 s, so give the page one poll."""
    return [{'eval': "fetch('/__%s').then((r) => r.json())" % q}, {'wait': wait}]


def open_thread(t, phone):
    if phone:
        return js("(() => { const m = document.querySelector('mark.hl[data-t=\"%s\"]'); m.scrollIntoView({ block: 'center' }); m.click(); return true })()" % t, 800)
    return js("(() => { const c = document.querySelector('#cards .card[data-t=\"%s\"]'); c.scrollIntoView({ block: 'center' }); c.querySelector('.q').click(); return true })()" % t, 700)


def close(phone):
    return js("(() => { document.querySelector('#scrim')?.click(); return true })()", 500) if phone else []


def cmd_enter(t, text):
    """Type his note the way the browser does (value, then input), then press ⌘Enter in the box."""
    return [{'eval': "(() => { " + H + " const b = box(%s); if (!b) return 'no box'; b.focus(); b.value = %s; b.dispatchEvent(new Event('input', { bubbles: true })); "
                     "const ev = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', metaKey: true, bubbles: true, cancelable: true }); box(%s).dispatchEvent(ev); return ev.defaultPrevented })()"
                     % (json.dumps(t), json.dumps(text), json.dumps(t))}]


def scenario(phone, label):
    steps = [{'wait_for': 'mark.hl[data-t="T1"]'}, {'wait': 400}]
    # 1: a note plus ⌘Enter is a reply.
    steps += [*open_thread('T1', phone), *cmd_enter('T1', 'is Executor fast enough?'), {'wait': 1500},
              C(f'{label}: a note plus ⌘Enter posts a reply and the question stays open, with Approve', H + " const c = where('T1'); const m = [...(c?.querySelectorAll('.msgs .msg') || [])].at(-1); const a = c?.querySelector('[data-action=\"take\"]'); "
                "return {ok: !!m && m.textContent.includes('is Executor fast enough?') && !c.querySelector('.settled') && vis(a) && a.textContent.trim() === 'Approve' && box('T1')?.value === '', last: m?.textContent, settled: !!c?.querySelector('.settled'), approve: a?.textContent}"),
              {'shot': f'{label}-replied'},
              *close(phone)]
    # 2, 3: no note sends nothing; Approve with a note takes it.
    steps += [*hook('ask?id=T8'), *open_thread('T8', phone), *cmd_enter('T8', ''), {'wait': 800},
              C(f'{label}: ⌘Enter with no note decides nothing', H + " return {ok: !where('T8')?.querySelector('.settled') && vis(where('T8')?.querySelector('[data-action=\"take\"]'))}"),
              *js("(() => { " + H + " const b = box('T8'); b.value = 'ok, ship it'; b.dispatchEvent(new Event('input', { bubbles: true })); where('T8').querySelector('[data-action=\"take\"]').click(); return true })()", 1500),
              *close(phone)]
    # 4: an envelope-only push.
    if phone:
        steps += [*js("(() => { window.__docNode = document.querySelector('#doc p'); return !!window.__docNode })()", 100), *hook('envelope'),
                  C(f'{label}: an envelope-only push does not redraw the doc', "return {ok: !!window.__docNode && window.__docNode.isConnected}")]
    else:
        steps += [*open_thread('T2', phone),
                  *js("(() => { " + H + " const b = box('T2'); b.focus(); b.value = 'draft in progress'; b.dispatchEvent(new Event('input', { bubbles: true })); b.setSelectionRange(5, 5); window.__docNode = document.querySelector('#doc p'); window.__box = b; return true })()", 100),
                  *hook('envelope'),
                  C(f'{label}: an envelope-only push does not redraw the doc or the reply box', H + " return {ok: !!window.__docNode && window.__docNode.isConnected && window.__box.isConnected && document.activeElement === window.__box && window.__box.value === 'draft in progress' && window.__box.selectionStart === 5, doc: window.__docNode?.isConnected, box: window.__box?.isConnected, active: document.activeElement?.tagName}")]
    steps += [*hook('lane_edit'),
              C(f'{label}: a real lane edit still lands', "return {ok: document.querySelector('#doc').textContent.includes('We ship the page first, on phones.')}"),
              C(f'{label}: no page error', NO_ERRORS)]
    return steps


APPROVE_IN = ("(d, w) => { const vis = %s; const own = [...(d?.querySelectorAll('button, a, [role=button], [role=menuitem]') || [])].some((b) => vis(b) && b.textContent.trim() === 'Approve scope'); "
              "const told = (w.__msgs || []).some((m) => m.includes('\"approve-scope\"')); return own || told }") % VISIBLE


def approve_steps(label, framed, host):
    if not framed:
        return [{'wait_for': 'mark.hl[data-t="T1"]'}, {'wait': 800},
                C(f'{label}: a host-mode page nobody frames draws Approve scope', "const has = %s; return {ok: has(document, window)}" % APPROVE_IN),
                {'shot': f'{label}-approve'}]
    want = 'no' if host else 'yes'
    return [{'wait': 3500},
            C(f'{label}: framed {"with" if host else "without"} data-approve-host, Approve scope drawn: {want}',
              "const has = %s; const f = document.getElementById('f'); const d = f.contentDocument; const shown = has(d, window); return {ok: %s, shown, loaded: !!d?.querySelector('mark.hl[data-t=\"T1\"]')}"
              % (APPROVE_IN, "!!d?.querySelector('mark.hl[data-t=\"T1\"]') && " + ('!shown' if host else 'shown'))),
            {'shot': f'{label}-approve'}]


def page_shot(route, steps, width, theme, label):
    f = os.path.join(W, f'steps-{label}.json')
    json.dump(steps, open(f, 'w'))
    cmd = [os.path.expanduser('~/.local/bin/page-shot'), f'http://127.0.0.1:{PORT}{route}', '--out', os.path.join(OUT, 'shots'), '--widths', str(width),
           '--themes', theme, '--viewport-only', '--steps', f, '--timeout', '90']
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
    errors = [e for e in errors if 'status of 404' not in str(e) and 'status of 500' not in str(e)]
    check(f'{label}: no console errors', not errors, str(errors)[:600])
    print('shots:', out.get('dir'), flush=True)


def reset(log):
    urllib.request.urlopen(urllib.request.Request(f'http://127.0.0.1:{PORT}/__reset', data=b'{}', method='POST')).read()
    open(log, 'w').close()


def entries(log):
    return [json.loads(l) for l in open(log) if l.strip()]


def run():
    subprocess.run(['pkill', '-f', f'scope-admin-stub.mjs {PORT}'], capture_output=True)
    shutil.rmtree(W, ignore_errors=True)
    os.makedirs(W)
    env = {**os.environ, 'PATH': os.path.join(WT, 'web', 'node_modules', '.bin') + ':' + os.environ['PATH']}
    if '--no-build' not in sys.argv:
        b = subprocess.run(['npm', 'run', 'build:scope-bundle'], cwd=WT, env=env, capture_output=True, text=True)
        check('bundle builds', b.returncode == 0, (b.stdout + b.stderr)[-1500:])
        if b.returncode:
            return
    log = os.path.join(W, f'stub-{PORT}.log')
    stub = subprocess.Popen(['node', os.path.join(E, 'scope-admin-stub.mjs'), str(PORT), WT, DIST, log, 'admin'], stdout=open(os.path.join(W, f'stub-{PORT}.out'), 'w'), stderr=subprocess.STDOUT)
    try:
        for _ in range(50):
            try:
                urllib.request.urlopen(f'http://127.0.0.1:{PORT}/scope/demo').read()
                break
            except Exception:
                time.sleep(0.2)
        for width in (1280, 390):
            reset(log)
            label = f'{width}'
            page_shot('/scope/demo', scenario(width < 600, label), width, 'light', label)
            posts = [e for e in entries(log) if e['method'] == 'POST' and e['path'].startswith('/w/api/live-scopes/demo/threads')]
            got = [(e['path'].rsplit('/', 2)[1], e['path'].rsplit('/', 1)[1], (e.get('body') or {}).get('how'), (e.get('body') or {}).get('alex_words') or (e.get('body') or {}).get('text')) for e in posts if '/T2/' not in e['path']]
            check(f'{label}: one reply on T1 with his note and one take on T8 with his note; no pick, nothing else',
                  got == [('T1', 'reply', None, 'is Executor fast enough?'), ('T8', 'resolve', 'take', 'ok, ship it')], got)
            check(f'{label}: nothing was written to T2 by the envelope push', not [e for e in posts if '/T2/' in e['path']])
            for name, route, framed, host in (('unframed', '/scope/demo', False, False), ('framed-no-host', '/frame/demo', True, False), ('framed-host', '/frame/demo?host=1', True, True)):
                reset(log)
                page_shot(route, approve_steps(f'{label}-{name}', framed, host), width, 'light', f'{label}-{name}')
    finally:
        stub.terminate()


run()
bad = [r for r in results if not r[1]]
print(f'\n{len(results) - len(bad)}/{len(results)} passed')
sys.exit(1 if bad else 0)
