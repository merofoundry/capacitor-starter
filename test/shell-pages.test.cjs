'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { HtmlValidate } = require('html-validate');
const { parse } = require('parse5');

const SHELL = path.join(__dirname, '..', 'shell');
const pages = fs.readdirSync(SHELL).filter((f) => f.endsWith('.html'));
const validator = new HtmlValidate({ extends: ['html-validate:recommended'] });

function elements(node, out = []) {
  if (node.tagName) {
    out.push(node);
  }
  (node.childNodes || []).forEach((child) => elements(child, out));
  if (node.content) {
    elements(node.content, out);
  }
  return out;
}

const attr = (el, name) => (el.attrs.find((a) => a.name === name) || {}).value;

/** A reference is local when it is a relative path that resolves to a file inside shell/. */
function assertLocal(page, ref) {
  assert.ok(ref, `${page}: empty reference`);
  assert.doesNotMatch(ref, /^[a-z][a-z0-9+.-]*:|^\/\//i, `${page}: ${ref} names another origin`);
  assert.ok(!ref.startsWith('/'), `${page}: ${ref} is an absolute path`);
  const resolved = path.resolve(SHELL, ref);
  assert.ok(resolved.startsWith(SHELL + path.sep), `${page}: ${ref} leaves shell/`);
  assert.ok(fs.existsSync(resolved), `${page}: ${ref} does not exist`);
}

test('the shell has pages to validate', () => {
  assert.ok(pages.includes('index.html'));
});

for (const page of pages) {
  test(`${page} is valid HTML`, async () => {
    const report = await validator.validateFile(path.join(SHELL, page));
    const messages = report.results.flatMap((r) => r.messages.map((m) => `${m.line}:${m.column} ${m.ruleId} ${m.message}`));
    assert.deepEqual(messages, []);
    assert.equal(report.valid, true);
  });

  test(`${page} loads no external script or stylesheet`, () => {
    const all = elements(parse(fs.readFileSync(path.join(SHELL, page), 'utf8')));
    for (const el of all) {
      if (el.tagName === 'script' && attr(el, 'src') !== undefined) {
        assertLocal(page, attr(el, 'src'));
      }
      if (el.tagName === 'link') {
        assertLocal(page, attr(el, 'href'));
      }
      if (el.tagName === 'style' || el.tagName === 'iframe' || el.tagName === 'base') {
        assert.fail(`${page}: <${el.tagName}> is not allowed in shell pages`);
      }
    }
    const css = all
      .filter((el) => el.tagName === 'link' && attr(el, 'rel') === 'stylesheet')
      .map((el) => fs.readFileSync(path.join(SHELL, attr(el, 'href')), 'utf8'));
    for (const sheet of css) {
      assert.doesNotMatch(sheet, /@import|url\(\s*['"]?(https?:)?\/\//i, `${page}: stylesheet pulls remote content`);
    }
  });
}

test('every screen, field and action the view binds exists in index.html', () => {
  const html = fs.readFileSync(path.join(SHELL, 'index.html'), 'utf8');
  const all = elements(parse(html));
  const views = new Set(all.map((el) => attr(el, 'data-view')).filter(Boolean));
  const actions = new Set(all.map((el) => attr(el, 'data-action')).filter(Boolean));
  for (const view of ['boot', 'privacy', 'lock', 'offline', 'settings']) {
    assert.ok(views.has(view), `missing data-view="${view}"`);
  }
  for (const action of ['unlock', 'retry', 'openSettings', 'closeSettings', 'signOut', 'setLock']) {
    assert.ok(actions.has(action), `missing data-action="${action}"`);
  }
  const visible = all.filter((el) => attr(el, 'data-view') && attr(el, 'hidden') === undefined);
  assert.deepEqual(visible.map((el) => attr(el, 'data-view')), ['boot'], 'only the boot screen is visible before scripts run');
});
