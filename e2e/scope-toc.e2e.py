#!/usr/bin/env python3
"""Owner-boundary browser scenario for scrollable scopes and responsive contents.

Runs the real bundled page against the admin HTTP boundary with synthetic data.
"""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import urllib.request
from playwright.sync_api import sync_playwright

WT = Path(__file__).resolve().parents[1]
PORT = 4640
OUT = Path(os.environ.get('TMPDIR', tempfile.gettempdir()))
at = '2026-10-07T12:00:00.000Z'
fixture = {'title': {'heading': 'Synthetic scrollable scope', 'body_md': 'A six-section planning document.', 'updated_at': at}}
for i in range(1, 6):
    fixture[f'section-{i}'] = {'heading': f'Section {i} {{#section-{i}}}', 'body_md': '\n\n'.join(f'Synthetic section {i} supporting paragraph {j}.' for j in range(12)), 'updated_at': at}


def check(name, ok):
    print(('PASS' if ok else 'FAIL') + ': ' + name, flush=True)
    assert ok, name


def run():
    env = {**os.environ, 'PATH': str(WT / 'web/node_modules/.bin') + ':' + os.environ['PATH']}
    build = subprocess.run(['npm', 'run', 'build:scope-bundle'], cwd=WT, env=env, capture_output=True, text=True)
    check('bundle builds', build.returncode == 0)
    with tempfile.TemporaryDirectory(prefix='scope-toc-', dir=OUT) as work:
        source = (WT / 'e2e/scope-admin-stub.mjs').read_text()
        start = source.index('  sections = {')
        end = source.index('\n}', source.index('  threads = [', start))
        source = source[:start] + '  sections = ' + json.dumps(fixture) + ';\n  threads = [{ id: "T1", anchor: { section: "section-2", quote: "Synthetic section 2 supporting paragraph 0.", prefix: "", suffix: "" }, kind: "comment", status: "open", messages: [{ from: "alex", text: "Synthetic open comment.", at: "' + at + '", via: "admin" }] }];' + source[end:]
        stub_file = Path(work) / 'admin-stub.mjs'
        stub_file.write_text(source)
        with open(Path(work) / 'stub.out', 'w') as log:
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
                    for width in (1280, 390):
                        for theme in ('light', 'dark'):
                            page = browser.new_page(viewport={'width': width, 'height': 800}, color_scheme=theme)
                            page.goto(f'http://127.0.0.1:{PORT}/scope/demo')
                            page.wait_for_selector('.scope-toc')
                            prefix = f'{width} {theme}: '
                            links = page.locator('.toc-list a')
                            check(prefix + 'five entries in document order', links.all_text_contents() == [f'Section {i}' for i in range(1, 6)])
                            check(prefix + 'open comment dot', page.locator('.toc-dot').count() == 1)
                            if width < 1200:
                                check(prefix + 'collapsed by default', not page.locator('.scope-toc details').evaluate('(e) => e.open'))
                                page.locator('.scope-toc summary').click()
                                check(prefix + 'disclosure shows entries', all(links.nth(i).is_visible() for i in range(5)))
                            links.nth(3).click()
                            page.wait_for_function('() => Math.abs(document.querySelector("#section-4").getBoundingClientRect().top - ((document.querySelector(".pc-bar")?.getBoundingClientRect().height || 0) + 24)) < 3')
                            check(prefix + 'clicked section current', links.nth(3).get_attribute('aria-current') == 'location')
                            check(prefix + 'URL hash', page.evaluate('location.hash') == '#section-4')
                            if width >= 1200:
                                check(prefix + 'sticky contents visible', links.nth(0).is_visible() and page.locator('.scope-toc').evaluate('(e) => e.getBoundingClientRect().top >= 0'))
                                page.locator('#section-2').evaluate('(e) => window.scrollTo(0, scrollY + e.getBoundingClientRect().top - 76)')
                                page.wait_for_function('() => document.querySelectorAll(".toc-list a")[1].getAttribute("aria-current") === "location"')
                                check(prefix + 'reader scroll updates current', links.nth(1).get_attribute('aria-current') == 'location')
                                check(prefix + 'columns do not overlap', page.evaluate('document.querySelector(".scope-toc").getBoundingClientRect().right <= document.querySelector(".doc").getBoundingClientRect().left && document.querySelector(".doc").getBoundingClientRect().right <= document.querySelector(".side").getBoundingClientRect().left'))
                            else:
                                check(prefix + 'selection closes disclosure', not page.locator('.scope-toc details').evaluate('(e) => e.open'))
                            check(prefix + 'no horizontal overflow', page.evaluate('document.documentElement.scrollWidth <= innerWidth'))
                            path = OUT / f'scope-toc-{width}-{theme}.png'
                            page.screenshot(path=str(path))
                            print('SCREENSHOT: ' + str(path), flush=True)
                            if width == 1280:
                                page.set_viewport_size({'width': 1440, 'height': 800})
                                check(prefix + '1440 no overflow or overlap', page.evaluate('document.documentElement.scrollWidth <= innerWidth && document.querySelector(".scope-toc").getBoundingClientRect().right <= document.querySelector(".doc").getBoundingClientRect().left && document.querySelector(".doc").getBoundingClientRect().right <= document.querySelector(".side").getBoundingClientRect().left'))
                            page.close()
                    browser.close()
            finally:
                stub.terminate()
                stub.wait(timeout=5)


if __name__ == '__main__':
    run()
