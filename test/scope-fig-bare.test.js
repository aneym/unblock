// Owner test (Opus, 2026-09-30; the implementer may not edit it).
// Alex on /s/page-agents T10 (2026-09-30 10:36 ET): "we dont need a wraper container aorund the demo here".
// A scope page's figure sits straight on the page: no border, no card background, no padding box.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../web/src/scope/scope.css', import.meta.url), 'utf8');

function rulesFor(selector) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const selectors = m[1].split(',').map((s) => s.trim());
    if (selectors.includes(selector)) out.push(m[2]);
  }
  return out;
}

test('the scope figure has no wrapper box', () => {
  const bodies = rulesFor('.fig');
  assert.ok(bodies.length > 0, '.fig rule still exists');
  for (const body of bodies) {
    for (const decl of body.split(';').map((d) => d.trim()).filter(Boolean)) {
      const [prop, ...rest] = decl.split(':');
      const name = prop.trim();
      const value = rest.join(':').trim();
      if (/^border(-|$)/.test(name)) assert.match(value, /^(none|0)$/, `.fig ${name}: ${value}`);
      if (/^background(-color)?$/.test(name)) assert.match(value, /^(none|transparent)$/, `.fig ${name}: ${value}`);
      if (/^padding(-|$)/.test(name)) assert.match(value, /^0(px)?$/, `.fig ${name}: ${value}`);
    }
  }
});
