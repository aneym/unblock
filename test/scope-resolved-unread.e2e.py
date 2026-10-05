#!/usr/bin/env python3
"""Browser regression: unread replies do not override the Resolved checkbox.

Uses the real scope bundle and existing HTTP/SSE fixture. The older resolved
scenario has no agent reply after a human message, so it cannot catch this bug.
No test-only production seam is needed.
Usage: python3 test/scope-resolved-unread.e2e.py
"""
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
OUT = Path(os.environ['E2E_OUT']) / 'resolved-unread'
OUT.mkdir(parents=True, exist_ok=True)
PORT = 4599
BASE = f'http://127.0.0.1:{PORT}'


def check(name, expression):
    return {'eval': f'(() => {{ const c = (id) => document.querySelector(`#cards .card[data-t="${{id}}"]`); const vis = (n) => !!n && n.getClientRects().length > 0; return {{ check: {json.dumps(name)}, ok: !!({expression}) }} }})()'}


steps = [
    {'wait_for': '#cards .card[data-t="T2"]'},
    {'eval': "localStorage.removeItem('scope:seen:demo:T2'); document.querySelector('#showResolved').checked && document.querySelector('#showResolved').click(); fetch('/__lane_answer?thread=T2').then(() => fetch('/__agent_resolve?thread=T2')).then(() => true)"},
    {'wait': 1000},
    check('resolved unread hidden with Resolved unchecked; open comment remains', "!document.querySelector('#showResolved').checked && !vis(c('T2')) && vis(c('T4'))"),
    {'eval': "document.querySelector('#showResolved').click()"},
    {'wait': 400},
    check('Resolved checked shows the unread reply and the open comment', "document.querySelector('#showResolved').checked && vis(c('T2')) && c('T2').textContent.includes('New reply') && vis(c('T4'))"),
    {'eval': "document.querySelector('#showResolved').click()"},
    {'wait': 400},
    check('unchecking hides the unread comment again without hiding open comments', "!vis(c('T2')) && vis(c('T4'))"),
    {'shot': 'resolved-unread'},
]
steps_file = OUT / 'steps.json'
steps_file.write_text(json.dumps(steps))
with (OUT / 'stub.out').open('w') as log:
    stub = subprocess.Popen(['node', str(ROOT / 'e2e/scope-stub.mjs'), str(PORT), str(ROOT), str(ROOT / 'web/dist-scope'), str(OUT / 'requests.jsonl'), 'solo'], stdout=log, stderr=subprocess.STDOUT)
    try:
        for _ in range(50):
            try:
                urllib.request.urlopen(BASE + '/scope/demo').read()
                break
            except OSError:
                time.sleep(0.1)
        run = subprocess.run([str(Path.home() / '.local/bin/page-shot'), BASE + '/scope/demo', '--out', str(OUT / 'shots'), '--widths', '1280', '--themes', 'light', '--viewport-only', '--steps', str(steps_file), '--timeout', '60'], capture_output=True, text=True)
        if run.returncode:
            raise RuntimeError(run.stdout + run.stderr)
        result = json.loads(run.stdout)
        checks = [ev['value'] for shot in result.get('shots', []) for ev in shot.get('evals', []) if isinstance(ev.get('value'), dict) and 'check' in ev['value']]
        for item in checks:
            print(('PASS ' if item['ok'] else 'FAIL ') + item['check'])
        assert len(checks) == 3, result
        assert all(item['ok'] for item in checks), checks
        assert not any(shot.get('error') for shot in result['shots']), result
        assert not result.get('console_errors'), result.get('console_errors')
        print('3/3 passed')
    finally:
        stub.terminate()
        stub.wait(timeout=5)
