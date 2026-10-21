/*
 * Shell controller. Runs in the native overlay WebView and decides what the user sees:
 * the boot curtain, the lock screen, the offline screen, the settings screen, or the hosted
 * application. The native side only carries out commands (cover, reveal, authenticate,
 * clearCookies, loadHost, ...) and reports events (pageLoaded, pageFailed, resume, deepLink,
 * insets, openSettings, refreshRequested). The hosted page is revealed only when the shell is unlocked, no
 * shell screen is open and the page has loaded.
 */
(function (root, factory) {
  const deps = typeof require === 'function' ? require('./deep-link.js') : root.MeroShell;
  const api = factory(deps);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.MeroShell = Object.assign(root.MeroShell || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (deps) {
  'use strict';

  const resolveDeepLink = deps.resolveDeepLink;
  const AUTH_CODES = ['cancelled', 'failed', 'lockout', 'unavailable'];
  const INSET_SIDES = ['top', 'right', 'bottom', 'left'];

  /**
   * @param {unknown} insets
   * @returns {{top: number, right: number, bottom: number, left: number} | null}
   */
  function validInsets(insets) {
    if (!insets || typeof insets !== 'object') {
      return null;
    }
    const result = {};
    for (const side of INSET_SIDES) {
      const value = insets[side];
      if (typeof value !== 'number' || !isFinite(value) || value < 0) {
        return null;
      }
      result[side] = value;
    }
    return result;
  }

  /**
   * @param {{native: {call: (cmd: string, args?: object) => Promise<any>},
   *          view: {show: (name: string, data: object) => void, applyInsets: (insets: object) => void},
   *          log?: (...args: any[]) => void}} ports
   */
  function createController(ports) {
    const native = ports.native;
    const view = ports.view;
    const log = ports.log || function () {};

    const state = {
      launch: null,
      lockEnabled: false,
      locked: false,
      unlocking: false,
      authenticating: false,
      lockStatus: 'prompt',
      lockMessage: '',
      page: 'loading',
      failedUrl: null,
      retrying: false,
      revealed: false,
      settingsOpen: false,
      settingsBusy: '',
      settingsError: '',
      insets: null,
    };
    const pending = [];
    let tail = Promise.resolve();

    /** Run state transitions one at a time, in arrival order. */
    function enqueue(task) {
      const run = tail.then(task);
      tail = run.catch(function (error) {
        log('shell task failed', error);
      });
      return run;
    }

    function host() {
      return state.launch.host;
    }

    function lockData() {
      return {
        status: state.lockStatus,
        message: state.lockMessage,
        appName: state.launch.appName,
        biometryKind: state.launch.biometry ? state.launch.biometry.kind : 'none',
      };
    }

    function lockAvailable() {
      return Boolean(state.launch.biometry && state.launch.biometry.available);
    }

    function settingsData() {
      return {
        appName: state.launch.appName,
        host: host(),
        appVersion: state.launch.appVersion,
        starterVersion: state.launch.starterVersion,
        lockEnabled: state.lockEnabled,
        lockAvailable: lockAvailable(),
        biometryKind: state.launch.biometry ? state.launch.biometry.kind : 'none',
        busy: state.settingsBusy,
        error: state.settingsError,
      };
    }

    async function showOverlay(name, data) {
      view.show(name, data);
      if (state.revealed) {
        state.revealed = false;
        await native.call('cover');
      }
    }

    async function reveal() {
      view.show('privacy', { appName: state.launch.appName });
      if (!state.revealed) {
        state.revealed = true;
        await native.call('reveal');
      }
    }

    /** Show whatever the current state calls for. */
    async function settle() {
      if (state.locked) {
        return showOverlay('lock', lockData());
      }
      if (state.settingsOpen) {
        return showOverlay('settings', settingsData());
      }
      if (state.page === 'failed') {
        return showOverlay('offline', { status: state.retrying ? 'retrying' : 'failed', host: host() });
      }
      if (state.page === 'loaded') {
        return reveal();
      }
      return showOverlay('boot', { appName: state.launch.appName });
    }

    async function authenticate(reason) {
      state.authenticating = true;
      try {
        const result = await native.call('authenticate', { reason: reason });
        if (result && result.ok === true) {
          return { ok: true };
        }
        const code = result && AUTH_CODES.indexOf(result.code) >= 0 ? result.code : 'failed';
        return { ok: false, code: code, message: (result && result.message) || '' };
      } catch (error) {
        return { ok: false, code: 'failed', message: String((error && error.message) || error) };
      } finally {
        state.authenticating = false;
      }
    }

    /** Prompt for device authentication; the hosted page stays covered until it succeeds. */
    async function unlock() {
      if (!state.locked || state.unlocking || state.authenticating) {
        return;
      }
      state.unlocking = true;
      try {
        state.lockStatus = 'prompt';
        state.lockMessage = '';
        await enqueue(function () {
          return showOverlay('lock', lockData());
        });
        const result = await authenticate('Unlock ' + state.launch.appName);
        await enqueue(function () {
          if (result.ok) {
            state.locked = false;
          } else {
            state.lockStatus = result.code;
            state.lockMessage = result.message;
          }
          return settle();
        });
      } finally {
        state.unlocking = false;
      }
    }

    const handlers = {
      pageLoaded: async function () {
        state.page = 'loaded';
        state.retrying = false;
        state.failedUrl = null;
        if (state.insets) {
          await native.call('applyHostInsets', state.insets);
        }
      },
      pageFailed: async function (payload) {
        state.page = 'failed';
        state.retrying = false;
        state.failedUrl = payload && typeof payload.url === 'string' ? payload.url : null;
      },
      resume: async function (payload) {
        if (state.unlocking || state.authenticating) {
          return;
        }
        if (state.lockEnabled && payload && payload.backgrounded) {
          state.locked = true;
          state.lockStatus = 'prompt';
          state.lockMessage = '';
          view.show('lock', lockData());
          await native.call('cover');
          state.revealed = false;
          void unlock();
          return;
        }
        // The native side covered the page for privacy without backgrounding; lift it.
        state.revealed = false;
      },
      deepLink: async function (payload) {
        const path = resolveDeepLink(payload && payload.url, host());
        if (path === null) {
          log('ignored deep link outside the application host');
          return;
        }
        state.settingsOpen = false;
        if (state.page === 'failed') {
          state.page = 'loading';
        }
        await native.call('loadHost', { path: path });
      },
      insets: async function (payload) {
        const insets = validInsets(payload);
        if (!insets) {
          log('ignored malformed insets');
          return;
        }
        state.insets = insets;
        view.applyInsets(insets);
        await native.call('applyHostInsets', insets);
      },
      openSettings: async function () {
        state.settingsOpen = true;
        state.settingsError = '';
      },
      refreshRequested: async function (payload) {
        if (!hostedPageShown()) {
          log('ignored refresh while the hosted page is not shown');
          return;
        }
        const path = resolveDeepLink(payload && payload.url, host()) || '/';
        // The page stays shown while it reloads; an unreachable host arrives as pageFailed and
        // shows the offline screen, whose retry reloads this same path.
        await native.call('loadHost', { path: path });
      },
    };

    /** Pull to refresh is honoured only while the user can actually see the hosted page. */
    function hostedPageShown() {
      return state.revealed && state.page === 'loaded' && !state.locked && !state.unlocking &&
        !state.authenticating && !state.settingsOpen;
    }

    const actions = {
      unlock: function () {
        return unlock();
      },
      openSettings: function () {
        return enqueue(function () {
          state.settingsOpen = true;
          state.settingsError = '';
          return settle();
        });
      },
      closeSettings: function () {
        return enqueue(function () {
          state.settingsOpen = false;
          return settle();
        });
      },
      retry: function () {
        return enqueue(async function () {
          const path = (state.failedUrl && resolveDeepLink(state.failedUrl, host())) || '/';
          state.retrying = true;
          await settle();
          await native.call('loadHost', { path: path });
        });
      },
      setLock: async function (payload) {
        const enabled = Boolean(payload && payload.enabled);
        if (enabled && !lockAvailable()) {
          return enqueue(function () {
            state.settingsError = 'Set up Face ID, Touch ID, fingerprint or a device passcode first.';
            return settle();
          });
        }
        if (enabled) {
          const result = await authenticate('Turn on app lock for ' + state.launch.appName);
          if (!result.ok) {
            return enqueue(function () {
              state.settingsError = result.code === 'cancelled' ? '' : 'App lock was not turned on.';
              return settle();
            });
          }
        }
        return enqueue(async function () {
          await native.call('setLockEnabled', { enabled: enabled });
          state.lockEnabled = enabled;
          state.settingsError = '';
          return settle();
        });
      },
      signOut: function () {
        return enqueue(async function () {
          state.settingsBusy = 'signing-out';
          state.settingsError = '';
          await settle();
          try {
            await native.call('clearCookies');
          } catch (error) {
            state.settingsBusy = '';
            state.settingsError = 'Could not clear cookies: ' + String((error && error.message) || error);
            return settle();
          }
          state.settingsBusy = '';
          state.settingsOpen = false;
          state.page = 'loading';
          await settle();
          await native.call('loadHost', { path: '/' });
        });
      },
    };

    /** Native event entry point. Events before launch state is known wait for it. */
    function handleEvent(name, payload) {
      const handler = handlers[name];
      if (!handler) {
        log('ignored unknown event', name);
        return Promise.resolve();
      }
      if (!state.launch) {
        pending.push([handler, payload]);
        return Promise.resolve();
      }
      return enqueue(async function () {
        await handler(payload);
        return settle();
      });
    }

    /** User action entry point, wired to the shell's buttons. */
    function act(name, payload) {
      const action = actions[name];
      if (!action || !state.launch) {
        log('ignored action', name);
        return Promise.resolve();
      }
      return action(payload);
    }

    async function start() {
      view.show('boot', {});
      const launch = await native.call('ready');
      state.launch = launch;
      state.lockEnabled = Boolean(launch.lockEnabled);
      state.locked = state.lockEnabled;
      await enqueue(async function () {
        const queued = pending.splice(0);
        for (let i = 0; i < queued.length; i += 1) {
          await queued[i][0](queued[i][1]);
        }
        return settle();
      });
      if (state.locked) {
        void unlock();
      }
    }

    return { start: start, handleEvent: handleEvent, act: act };
  }

  return { createController: createController };
});
