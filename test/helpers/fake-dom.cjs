'use strict';

/**
 * A small DOM built from a parsed HTML file, implementing only what shell/view.js uses:
 * attribute selectors, getElementById, closest, hidden, textContent, checked, disabled,
 * style custom properties and document-level event listeners. It is a test double for the
 * WebView's DOM, not a browser: layout, CSS and real event propagation are not modelled.
 */

const { parse } = require('parse5');

const SELECTOR = /^\[([a-z-]+)(?:="([^"]*)")?\]$/;

class FakeElement {
  constructor(node, parent) {
    this.tagName = node.tagName ? node.tagName.toUpperCase() : '#text';
    this.parent = parent;
    this.attrs = new Map((node.attrs || []).map((a) => [a.name, a.value]));
    this.text = node.nodeName === '#text' ? node.value : null;
    this.children = [];
    this.checked = this.attrs.has('checked');
    this.disabled = this.attrs.has('disabled');
    const props = new Map();
    this.style = {
      setProperty: (name, value) => props.set(name, value),
      getPropertyValue: (name) => props.get(name) || '',
    };
  }

  getAttribute(name) {
    return this.attrs.has(name) ? this.attrs.get(name) : null;
  }

  setAttribute(name, value) {
    this.attrs.set(name, String(value));
  }

  get hidden() {
    return this.attrs.has('hidden');
  }

  set hidden(value) {
    if (value) {
      this.attrs.set('hidden', '');
    } else {
      this.attrs.delete('hidden');
    }
  }

  get textContent() {
    if (this.text !== null) {
      return this.text;
    }
    return this.children.map((c) => c.textContent).join('');
  }

  set textContent(value) {
    this.children = [new FakeElement({ nodeName: '#text', value: String(value) }, this)];
  }

  matches(selector) {
    if (selector.startsWith('#')) {
      return this.getAttribute('id') === selector.slice(1);
    }
    const m = SELECTOR.exec(selector);
    if (!m) {
      throw new Error(`fake DOM does not support selector ${selector}`);
    }
    if (!this.attrs.has(m[1])) {
      return false;
    }
    return m[2] === undefined || this.attrs.get(m[1]) === m[2];
  }

  *descendants() {
    for (const child of this.children) {
      if (child.text === null) {
        yield child;
        yield* child.descendants();
      }
    }
  }

  querySelectorAll(selector) {
    return [...this.descendants()].filter((el) => el.matches(selector));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  closest(selector) {
    for (let el = this; el && el.text === null && el.tagName !== '#DOCUMENT'; el = el.parent) {
      if (el.matches(selector)) {
        return el;
      }
    }
    return null;
  }
}

function build(node, parent) {
  const el = new FakeElement(node, parent);
  for (const child of node.childNodes || []) {
    if (child.nodeName === '#comment' || child.nodeName === '#documentType') {
      continue;
    }
    el.children.push(build(child, el));
  }
  return el;
}

class FakeDocument {
  constructor(html) {
    const root = build({ tagName: '#document', childNodes: parse(html).childNodes }, null);
    root.tagName = '#DOCUMENT';
    this.root = root;
    this.documentElement = root.children.find((c) => c.tagName === 'HTML');
    this.listeners = {};
  }

  querySelectorAll(selector) {
    return this.root.querySelectorAll(selector);
  }

  querySelector(selector) {
    return this.root.querySelector(selector);
  }

  getElementById(id) {
    return this.root.querySelector(`#${id}`);
  }

  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }

  /** Deliver an event whose target is `el` to the document listeners. */
  dispatch(type, el) {
    for (const fn of this.listeners[type] || []) {
      fn({ type, target: el, preventDefault() {} });
    }
  }

  /** Simulate a tap: click, and for a checkbox also toggle it and fire change. */
  tap(el) {
    if (el.disabled) {
      return;
    }
    if (el.getAttribute('type') === 'checkbox') {
      el.checked = !el.checked;
      this.dispatch('click', el);
      this.dispatch('change', el);
      return;
    }
    this.dispatch('click', el);
  }

  visibleView() {
    const shown = this.querySelectorAll('[data-view]').filter((el) => !el.hidden);
    return shown.map((el) => el.getAttribute('data-view')).join(',');
  }
}

module.exports = { FakeDocument };
