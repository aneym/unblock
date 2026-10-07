#!/usr/bin/env python3
"""Owner-boundary e2e for the opt-in overview workspace.

Protects bounded light/dark layout, chapter selection comments after reload and
mobile overflow. Legacy tests have no overview fixture and cannot detect these
regressions. Uses the existing admin HTTP stub, no production test seam.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import urllib.request
from playwright.sync_api import sync_playwright

WT = Path(next((a for a in sys.argv[1:] if not a.startswith('--')), Path(__file__).resolve().parents[1])).resolve()
PORT = 4639
OUT = Path(os.environ.get('E2E_OUT', '/tmp'))
OUT.mkdir(parents=True, exist_ok=True)
results = []


def check(name, ok, detail=''):
    results.append(bool(ok))
    print(('PASS' if ok else 'FAIL') + ': ' + name + (' ' + str(detail) if detail else ''), flush=True)
    assert ok, name


at = '2026-10-07T12:00:00.000Z'
fixture = {
    'title': {'heading': 'A scope you can decide in one screen', 'body_md': 'Ship a bounded overview.'},
    'overview': {'heading': 'Recommendation', 'body_md': 'Keep the outcome, picture and questions together.'},
    'context': {'heading': 'Context', 'body_md': 'The problem: long scopes hide the decision.\n\nExample: a plan takes three screens.\n\nNot in scope: changing the approval API.\n\nTerms: a chapter is supporting detail.'},
    'picture': {'heading': 'The picture', 'body_md': '```svg\n<svg xmlns="http://www.w3.org/2000/svg" width="600" height="300" viewBox="0 0 600 300"><rect x="20" y="60" width="240" height="180" rx="16" fill="#e8f2fe"/><text x="48" y="152" fill="#0066cc" font-size="24">Scope</text><path d="M280 150H340" stroke="#0071e3" stroke-width="3"/><rect x="360" y="60" width="220" height="180" rx="16" fill="#e8f2fe"/><text x="385" y="152" fill="#0066cc" font-size="24">Build</text></svg>\n```\nFigure: Decide once, then build.'},
    'details': {'heading': 'Implementation', 'body_md': 'This sentence stays anchored after reload.\n\n' + '\n\n'.join('Supporting detail paragraph %d.' % i for i in range(35))},
    'delivery': {'heading': 'Delivery', 'body_md': 'The build runs after approval.\n\n```build\n' + json.dumps({'pieces': [{'id': 'overview', 'label': 'Overview', 'deps': [], 'p50_min': 5, 'p90_min': 10, 'runs_on': 'Studio'}]}) + '\n```'},
}
for section in fixture.values():
    section['updated_at'] = at


def run():
    env = {**os.environ, 'PATH': str(WT / 'web/node_modules/.bin') + ':' + os.environ['PATH']}
    if '--no-build' not in sys.argv:
        built = subprocess.run(['npm', 'run', 'build:scope-bundle'], cwd=WT, env=env, capture_output=True, text=True)
        check('bundle builds', built.returncode == 0, (built.stdout + built.stderr)[-500:])
    with tempfile.TemporaryDirectory(prefix='scope-one-screen-', dir=os.environ.get('TMPDIR')) as work:
        # Give the unchanged admin stub our scenario fixture at reset.
        source = (WT / 'e2e/scope-admin-stub.mjs').read_text()
        start = source.index('  sections = {')
        end = source.index('\n}', source.index('  threads = [', start))
        source = source[:start] + '  sections = ' + json.dumps(fixture) + ';\n  threads = [{ id: "T1", anchor: { section: "details", quote: "This sentence stays anchored after reload.", prefix: "Implementation\\n", suffix: "" }, kind: "comment", status: "open", messages: [{ from: "alex", text: "Keep this sentence.", at: "' + at + '", via: "admin" }] }];' + source[end:]
        stub_file = Path(work) / 'admin-stub.mjs'
        stub_file.write_text(source)
        log = open(Path(work) / 'stub.out', 'w')
        stub = subprocess.Popen(['node', str(stub_file), str(PORT), str(WT), str(WT / 'web/dist-scope'), str(Path(work) / 'writes.log'), 'admin'], stdout=log, stderr=subprocess.STDOUT)
        try:
            for _ in range(50):
                try:
                    urllib.request.urlopen(f'http://127.0.0.1:{PORT}/scope/demo').read()
                    break
                except Exception:
                    time.sleep(.2)
            with sync_playwright() as pw:
                browser = pw.chromium.launch()
                for theme in ('light', 'dark'):
                    page = browser.new_page(viewport={'width': 1280, 'height': 700}, color_scheme=theme)
                    page.goto(f'http://127.0.0.1:{PORT}/scope/demo')
                    page.wait_for_selector('.overview-chapters')
                    check(theme + ': no page scroll', page.evaluate('document.scrollingElement.scrollHeight <= innerHeight'))
                    for selector in ('.pc-head', '#context', '#picture', '.side', '.overview-build'):
                        check(theme + ': viewport ' + selector, page.locator(selector).evaluate('(e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight }'))
                    check(theme + ': figure readable scale', page.locator('#picture svg').evaluate('(e) => { const r = e.getBoundingClientRect(); return r.width >= 600 / 1.5 && r.height >= 300 / 1.5 }'))
                    check(theme + ': approval available', page.get_by_role('button', name='Approve scope', exact=True).is_visible())
                    page.screenshot(path=str(OUT / f'scope-one-screen-{theme}.png'))
                    page.locator('[data-chapter="details"]').click()
                    check(theme + ': chapter anchored thread', page.locator('#details mark[data-t="T1"]').is_visible())
                    page.evaluate('''() => { const p = document.querySelector('#details .body p'); const r = document.createRange(); r.selectNodeContents(p); const s = getSelection(); s.removeAllRanges(); s.addRange(r); const box = r.getBoundingClientRect(); p.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: box.left + 4, clientY: box.top + 4, button: 2 })); }''')
                    page.locator('#cards .composer textarea').fill('Persist the chapter note ' + theme)
                    page.locator('#cards .composer [data-action="post"]').click()
                    page.wait_for_function('(text) => [...document.querySelectorAll("#cards .card[data-t]")].some(e => e.textContent.includes(text))', arg='Persist the chapter note ' + theme)
                    page.reload()
                    page.wait_for_selector('.overview-chapters')
                    page.locator('[data-chapter="details"]').click()
                    check(theme + ': persisted sentence anchor', page.locator('#details mark.hl').filter(has_text='This sentence stays anchored after reload.').count() >= 2)
                    check(theme + ': persisted comment', page.locator('#cards').get_by_text('Persist the chapter note ' + theme, exact=True).count() == 1)
                    page.locator('[data-chapter="picture"]').click()
                    check(theme + ': return to picture', page.locator('#picture').is_visible() and not page.locator('#details').is_visible())
                    page.close()
                page = browser.new_page(viewport={'width': 390, 'height': 700})
                page.goto(f'http://127.0.0.1:{PORT}/scope/demo')
                page.wait_for_selector('.overview-chapters')
                check('mobile: no horizontal scroll', page.evaluate('document.scrollingElement.scrollWidth <= innerWidth'))
                page.screenshot(path=str(OUT / 'scope-one-screen-mobile.png'), full_page=True)
                browser.close()
        finally:
            stub.terminate()
            stub.wait(timeout=10)
            log.close()
    print('PASS: one-screen scenario; screenshots in ' + str(OUT))


if __name__ == '__main__':
    run()
