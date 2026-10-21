/*
 * The overlay's message channel to the native shell bootstrap. Commands go out as JSON
 * strings through the platform transport; results and events come back through
 * window.MeroShellChannel.receive(...), which the native side evaluates in the overlay.
 * This is not the Capacitor bridge: the overlay has no Capacitor plugins.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.MeroShell = Object.assign(root.MeroShell || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /**
   * @param {any} win
   * @returns {((message: string) => void) | null}
   */
  function detectTransport(win) {
    const android = win.MeroShellNative;
    if (android && typeof android.postMessage === 'function') {
      return function (message) {
        android.postMessage(message);
      };
    }
    const ios = win.webkit && win.webkit.messageHandlers && win.webkit.messageHandlers.meroShell;
    if (ios && typeof ios.postMessage === 'function') {
      return function (message) {
        ios.postMessage(message);
      };
    }
    return null;
  }

  /**
   * @param {(message: string) => void} post
   */
  function createChannel(post) {
    let nextId = 1;
    const pending = new Map();
    const queuedEvents = [];
    let listener = null;

    function call(cmd, args) {
      const id = nextId;
      nextId += 1;
      return new Promise(function (resolve, reject) {
        pending.set(id, { resolve: resolve, reject: reject });
        post(JSON.stringify({ id: id, cmd: cmd, args: args || {} }));
      });
    }

    function parse(message) {
      if (typeof message !== 'string') {
        return message;
      }
      try {
        return JSON.parse(message);
      } catch (error) {
        return null;
      }
    }

    function receive(raw) {
      const message = parse(raw);
      if (!message || typeof message !== 'object') {
        return;
      }
      if (message.type === 'result') {
        const waiter = pending.get(message.id);
        if (!waiter) {
          return;
        }
        pending.delete(message.id);
        if (message.ok) {
          waiter.resolve(message.value);
        } else {
          waiter.reject(new Error(message.error || 'native command failed'));
        }
        return;
      }
      if (message.type === 'event' && typeof message.name === 'string') {
        const payload = message.payload || {};
        if (listener) {
          listener(message.name, payload);
        } else {
          queuedEvents.push([message.name, payload]);
        }
      }
    }

    function onEvent(fn) {
      listener = fn;
      queuedEvents.splice(0).forEach(function (event) {
        fn(event[0], event[1]);
      });
    }

    return { call: call, receive: receive, onEvent: onEvent };
  }

  return { createChannel: createChannel, detectTransport: detectTransport };
});
