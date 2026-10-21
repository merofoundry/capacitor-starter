'use strict';

/**
 * Explicit doubles for the native boundary of the shell overlay.
 *
 * FakeNative stands in for the Android (MeroShellPlugin.java) and iOS (MeroShellPlugin.swift)
 * side of the overlay channel: it records every command in order and lets a test decide when
 * and how each one answers. It cannot establish anything about the device runtime: that the
 * overlay really covers the hosted WebView, that BiometricPrompt or LocalAuthentication behave
 * as modelled, that lifecycle callbacks arrive in this order, or that cookie stores clear.
 */

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class FakeNative {
  /** @param {Record<string, any>} [launch] */
  constructor(launch = {}) {
    this.launch = {
      platform: 'android',
      host: 'shop.example.com',
      appName: 'Shop',
      appVersion: '1.4.0 (12)',
      starterVersion: '1.0.0',
      lockEnabled: false,
      biometry: { available: true, kind: 'biometric' },
      ...launch,
    };
    /** @type {{cmd: string, args: any}[]} */
    this.calls = [];
    /** @type {Map<string, ReturnType<typeof deferred>[]>} */
    this.held = new Map();
    /** @type {Map<string, (args: any) => any>} */
    this.answers = new Map([
      ['ready', () => this.launch],
      ['authenticate', () => ({ ok: true })],
    ]);
  }

  /** Make the next calls of `cmd` wait until `release(cmd, ...)` is called. */
  hold(cmd) {
    if (!this.held.has(cmd)) {
      this.held.set(cmd, []);
    }
    this.holding = this.holding || new Set();
    this.holding.add(cmd);
  }

  /** Answer the oldest held call of `cmd`. */
  release(cmd, value) {
    const queue = this.held.get(cmd) || [];
    const next = queue.shift();
    if (!next) {
      throw new Error(`no held ${cmd} call`);
    }
    next.resolve(value);
    return flush();
  }

  /** Fail the oldest held call of `cmd`. */
  fail(cmd, error) {
    const queue = this.held.get(cmd) || [];
    const next = queue.shift();
    if (!next) {
      throw new Error(`no held ${cmd} call`);
    }
    next.reject(error);
    return flush();
  }

  answer(cmd, fn) {
    this.answers.set(cmd, fn);
  }

  call(cmd, args = {}) {
    this.calls.push({ cmd, args });
    if (this.holding && this.holding.has(cmd)) {
      const pending = deferred();
      this.held.get(cmd).push(pending);
      return pending.promise;
    }
    const answer = this.answers.get(cmd);
    return Promise.resolve(answer ? answer(args) : undefined);
  }

  commands() {
    return this.calls.map((c) => c.cmd);
  }

  count(cmd) {
    return this.calls.filter((c) => c.cmd === cmd).length;
  }

  indexOf(cmd) {
    return this.commands().indexOf(cmd);
  }
}

class FakeView {
  constructor() {
    /** @type {{name: string, data: any}[]} */
    this.shown = [];
    /** @type {any[]} */
    this.insets = [];
  }

  show(name, data) {
    this.shown.push({ name, data });
  }

  applyInsets(insets) {
    this.insets.push(insets);
  }

  get current() {
    return this.shown[this.shown.length - 1];
  }
}

/** Let every queued promise continuation run. */
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

module.exports = { FakeNative, FakeView, flush };
