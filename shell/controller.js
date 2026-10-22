/*
 * Shell controller. Runs in the native overlay WebView and decides what the user sees:
 * the boot curtain, the lock screen, the offline screen, the settings screen, or the hosted
 * application. The native side only carries out commands (cover, reveal, authenticate,
 * clearCookies, loadHost, ...) and reports events (pageLoaded, pageFailed, resume, deepLink,
 * insets, openSettings, refreshRequested, and the provider sign-in events). The hosted page is
 * revealed only when the shell is unlocked, no shell screen is open and the page has loaded.
 *
 * Provider sign-in (ADR 2026-10-16 v2, Ruling 6) runs as one "leg" at a time: the sign-in path
 * loads in the hosted WebView, native code cancels the first off-host redirect and reports it,
 * the controller has native open that provider URL in the system web-authentication session,
 * and only a validated return to this application's exchange route is loaded back into the
 * WebView. Every other outcome ends the leg, and an ended leg accepts nothing more.
 *
 * Bundled mode (ADR 2026-10-16 v2, Ruling 5): the site is packaged in the app, so the return is
 * not loaded in the hosted WebView. The validated exchange path gains session=bearer and native
 * code redeems it in the hosted WebView's cookie context, saves the token pair in secure storage
 * itself and answers only an outcome and returnTo. The controller then opens returnTo in the
 * bundled site and, once it has loaded, tells the page its session changed; no token ever
 * reaches this file. The offline screen appears only when the application host cannot be
 * reached during a sign-in leg: the bundled site itself loads locally. Sign-out also clears the
 * saved pair and reloads the bundled site's root.
 *
 * Push (ADR 2026-10-16 v2, Rulings 1 to 3 and section 3.3): the hosted page registers the device
 * with its own consumer session, so the controller only tells it the application id it read from
 * the host (setPushApplication), routes notification taps and asks the page to remove the
 * registration before sign-out clears the session. A tap's path is validated before anything
 * navigates; an accepted tap waits until the first page has loaded and the host probe has
 * answered, then opens once through the deep-link path (remote) or the bundled site (bundled).
 * A rejected tap never navigates: it is logged by reason only and reported to the page as a
 * meroshell:push rejection once a page is loaded. Sign-out waits at most
 * PUSH_DISABLE_TIMEOUT_MS for the page's cleanup and then continues whatever the outcome; no
 * push token ever reaches this file.
 */
(function (root, factory) {
  const deps = typeof require === 'function'
    ? Object.assign({}, require('./deep-link.js'), require('./web-auth.js'))
    : root.MeroShell;
  const api = factory(deps);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.MeroShell = Object.assign(root.MeroShell || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (deps) {
  'use strict';

  const resolveDeepLink = deps.resolveDeepLink;
  const resolveLocalPage = deps.resolveLocalPage;
  const checkPushPath = deps.checkPushPath;
  const webAuth = deps;
  // How long a closed Custom Tab waits for its return link before the leg counts as cancelled:
  // Android may deliver the activity resume before the app-link intent that carries the return.
  const WEB_AUTH_CLOSE_GRACE_MS = 1500;
  // How long sign-out waits for the hosted page to remove the push registration.
  const PUSH_DISABLE_TIMEOUT_MS = 5000;
  const AUTH_CODES = ['cancelled', 'failed', 'lockout', 'unavailable'];
  const INSET_SIDES = ['top', 'right', 'bottom', 'left'];
  const MODE_LABELS = { bundled: 'Bundled', remote: 'Remote' };
  const SIGN_OUT_HINTS = {
    bundled: "Sign out removes the saved sign-in and this app's cookies on this device and reloads the app.",
    remote: "Sign out removes this app's cookies on this device and reloads the site.",
  };

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
   *          log?: (...args: any[]) => void,
   *          schedule?: (fn: () => void, ms: number) => void}} ports
   */
  function createController(ports) {
    const native = ports.native;
    const view = ports.view;
    const log = ports.log || function () {};
    const schedule = ports.schedule || function (fn, ms) {
      setTimeout(fn, ms);
    };

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
      pageUrl: null,
      providerSignInSupported: false,
      applicationId: null,
      catalogProviderSignIn: false,
      announcedProviderSignIn: false,
      leg: null,
      pushSupported: false,
      announcedPushApplication: null,
      notificationsOn: false,
      pageReady: false,
      probing: false,
      pendingTap: null,
      pushRejections: [],
    };
    const pending = [];
    let tail = Promise.resolve();
    let legCount = 0;
    let probeCount = 0;

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

    function bundled() {
      return state.launch.mode === 'bundled';
    }

    function mode() {
      return bundled() ? 'bundled' : 'remote';
    }

    /** The path to reload for a page URL: a bundled page, or a page on the application host. */
    function pagePath(url) {
      return bundled() ? resolveLocalPage(url, state.launch.localOrigin) : resolveDeepLink(url, host());
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
        modeLabel: MODE_LABELS[mode()],
        signOutHint: SIGN_OUT_HINTS[mode()],
        appVersion: state.launch.appVersion,
        starterVersion: state.launch.starterVersion,
        notifications: state.notificationsOn ? 'On' : 'Off',
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

    /** Native support and the catalog boolean, both required, for a validated application. */
    function providerSignInAvailable() {
      return state.providerSignInSupported && state.catalogProviderSignIn && state.applicationId !== null;
    }

    /** Tell the hosted page when the effective capability changes. */
    async function announceCapabilities() {
      const enabled = providerSignInAvailable();
      if (enabled === state.announcedProviderSignIn) {
        return;
      }
      state.announcedProviderSignIn = enabled;
      await native.call('setHostCapabilities', { providerSignIn: enabled });
    }

    /**
     * Read the application id and the catalog from the configured host, once per launch and
     * again after sign-out. Any failure leaves provider sign-in off; nothing is cached across
     * launches.
     */
    async function probe() {
      probeCount += 1;
      const generation = probeCount;
      state.probing = true;
      let applicationId = null;
      let offered = false;
      try {
        applicationId = webAuth.readApplicationId(await native.call('fetchHost', { path: webAuth.BY_HOST_PATH }));
        if (applicationId !== null) {
          offered = webAuth.readCatalogProviderSignIn(await native.call('fetchHost', { path: webAuth.CATALOG_PATH }));
        }
      } catch (error) {
        log('provider sign-in probe failed', error);
      }
      if (applicationId === null) {
        log('provider sign-in off: the application id could not be validated');
      }
      return enqueue(async function () {
        if (generation !== probeCount) {
          return undefined;
        }
        state.probing = false;
        state.applicationId = applicationId;
        state.catalogProviderSignIn = offered;
        await announceCapabilities();
        await announcePushApplication();
        if (await deliverPendingTap()) {
          return settle();
        }
        return undefined;
      });
    }

    /** Whether the host should be probed: for provider sign-in or for the push application id. */
    function probeWanted() {
      return state.providerSignInSupported || state.pushSupported;
    }

    /** Tell native, and through it the hosted page, which application the device registers with. */
    async function announcePushApplication() {
      if (!state.pushSupported || state.applicationId === state.announcedPushApplication) {
        return;
      }
      state.announcedPushApplication = state.applicationId;
      await native.call('setPushApplication', { applicationId: state.applicationId });
    }

    /** True once a tap may navigate: a page has loaded and no host probe is still answering. */
    function tapDeliverable() {
      return state.pageReady && !state.probing;
    }

    /**
     * Open the pending tap's path once, through the same navigation a deep link takes.
     * @returns {Promise<boolean>} whether a tap was delivered
     */
    async function deliverPendingTap() {
      if (state.pendingTap === null || !tapDeliverable()) {
        return false;
      }
      const path = state.pendingTap;
      state.pendingTap = null;
      await cancelLeg();
      if (!bundled()) {
        await handlers.deepLink({ url: 'https://' + host() + path });
        return true;
      }
      state.settingsOpen = false;
      if (state.page === 'failed') {
        state.page = 'loading';
      }
      await native.call('loadHost', { path: path });
      return true;
    }

    /** Report rejected taps to the page, by reason only, once a page is loaded. */
    async function deliverPushRejections() {
      if (state.page !== 'loaded') {
        return;
      }
      const reasons = state.pushRejections.splice(0);
      for (let i = 0; i < reasons.length; i += 1) {
        await native.call('pushEvent', { type: 'rejected', reason: reasons[i] });
      }
    }

    /** Whether the device has push turned on, for the settings screen. Any failure reads as off. */
    async function readNotifications() {
      if (!state.pushSupported) {
        state.notificationsOn = false;
        return;
      }
      try {
        const result = await native.call('getPushState');
        state.notificationsOn = Boolean(result && result.enabled === true);
      } catch (error) {
        state.notificationsOn = false;
      }
    }

    /**
     * Resolve with 'disabled', 'failed' or 'timeout': the page's answer to disablePush, or the
     * timeout when it has not answered within `ms`.
     */
    function pushCleanupWithin(ms) {
      return new Promise(function (resolve) {
        let done = false;
        function finish(outcome) {
          if (!done) {
            done = true;
            resolve(outcome);
          }
        }
        schedule(function () {
          finish('timeout');
        }, ms);
        native.call('disablePush').then(function (result) {
          finish(result && result.ok === true ? 'disabled' : 'failed');
        }, function () {
          finish('failed');
        });
      });
    }

    /**
     * Before sign-out clears the session: the page removes the registration with that session.
     * On a failure or timeout native code still forgets the token, so nothing renews it later.
     */
    async function disablePushBeforeSignOut() {
      if (!state.pushSupported) {
        return;
      }
      state.pendingTap = null;
      const outcome = await pushCleanupWithin(PUSH_DISABLE_TIMEOUT_MS);
      if (outcome === 'disabled') {
        return;
      }
      log('push cleanup before sign-out ended: ' + outcome);
      try {
        await native.call('resetPush');
      } catch (error) {
        log('push reset before sign-out failed');
      }
    }

    function activeLeg(payload) {
      const id = payload && payload.leg;
      return state.leg !== null && state.leg.id === id ? state.leg : null;
    }

    /** End the leg; native stops intercepting redirects and closes any open session. */
    async function cancelLeg() {
      if (state.leg === null) {
        return;
      }
      state.leg = null;
      await native.call('cancelProviderSignIn');
    }

    /** A sign-in error that is not a cancellation: show the offline screen, retry the origin page. */
    function failLeg(reason) {
      const leg = state.leg;
      state.leg = null;
      log('provider sign-in failed', reason);
      state.page = 'failed';
      state.retrying = false;
      state.failedUrl = leg ? leg.originUrl : null;
    }

    /**
     * Bundled mode: native redeems the exchange and saves the pair. The answer is handled as its
     * own task, so the shell stays responsive while the request is in flight.
     */
    function redeemBearer(leg, path) {
      leg.phase = 'redeeming';
      native.call('exchangeSession', { path: path, leg: leg.id }).then(function (result) {
        return enqueue(async function () {
          await completeBearer(leg, result);
          return settle();
        });
      }, function (error) {
        return enqueue(function () {
          if (state.leg === leg) {
            state.leg = null;
            log('provider sign-in refused: the exchange could not be started', error);
          }
          return settle();
        });
      });
    }

    /** Open returnTo in the bundled site after a saved pair, or end the leg. */
    async function completeBearer(leg, result) {
      if (state.leg !== leg || leg.phase !== 'redeeming') {
        log('ignored an exchange answer for an ended sign-in');
        return;
      }
      const outcome = result && typeof result.status === 'string' ? result.status : 'malformed';
      if (outcome === 'unreachable') {
        failLeg('the application host could not be reached for the exchange');
        return;
      }
      if (outcome !== 'signedIn') {
        state.leg = null;
        log('provider sign-in ended: the exchange answered ' + outcome);
        return;
      }
      leg.phase = 'returning';
      await native.call('loadHost', { path: webAuth.localReturnPath(result.returnTo) || '/' });
    }

    const handlers = {
      pageLoaded: async function (payload) {
        state.page = 'loaded';
        state.pageReady = true;
        state.retrying = false;
        state.failedUrl = null;
        if (payload && typeof payload.url === 'string') {
          state.pageUrl = payload.url;
        }
        if (state.leg && state.leg.phase === 'starting') {
          // The sign-in path rendered a page instead of redirecting to a provider.
          log('provider sign-in ended: the sign-in page did not redirect');
          await cancelLeg();
        } else if (state.leg && state.leg.phase === 'exchanging') {
          state.leg = null;
        } else if (state.leg && state.leg.phase === 'returning') {
          // The bundled site has opened returnTo with the new pair already saved.
          state.leg = null;
          await native.call('sessionChanged', { signedIn: true });
        }
        if (state.insets) {
          await native.call('applyHostInsets', state.insets);
        }
        if (providerSignInAvailable()) {
          await native.call('setHostCapabilities', { providerSignIn: true });
        }
        await deliverPushRejections();
        await deliverPendingTap();
      },
      pageFailed: async function (payload) {
        const leg = state.leg;
        const url = payload && typeof payload.url === 'string' ? payload.url : null;
        if (bundled() && !(leg && resolveDeepLink(url, host()) !== null)) {
          // Only the application host can be offline; the bundled site keeps loading locally.
          log('ignored a failed load outside a sign-in navigation to the application host');
          if (leg && leg.phase === 'returning') {
            state.leg = null;
          }
          return;
        }
        if (leg) {
          await cancelLeg();
        }
        state.page = 'failed';
        state.retrying = false;
        state.failedUrl = leg ? leg.originUrl : (payload && typeof payload.url === 'string' ? payload.url : null);
      },
      resume: async function (payload) {
        if (state.unlocking || state.authenticating) {
          return;
        }
        if (state.lockEnabled && payload && payload.backgrounded) {
          // A return that arrives after the shell has locked must not navigate behind the lock.
          await cancelLeg();
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
        const url = payload && payload.url;
        if (webAuth.isExchangeLink(url, host()) || (state.leg && webAuth.isCallbackServiceLink(url, host()))) {
          log('ignored a sign-in link delivered as a deep link');
          return;
        }
        const path = resolveDeepLink(url, host());
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
        await readNotifications();
      },
      pushTapped: async function (payload) {
        const raw = payload ? payload.path : undefined;
        if (raw === undefined || raw === null || raw === '') {
          log('a notification without a path opened the app');
          return;
        }
        const checked = checkPushPath(raw);
        if (checked.reason) {
          log('rejected a notification tap: ' + checked.reason);
          state.pushRejections.push(checked.reason);
          await deliverPushRejections();
          return;
        }
        state.pendingTap = checked.path;
        await deliverPendingTap();
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
      providerSignInRequested: async function (payload) {
        if (!providerSignInAvailable()) {
          log('refused provider sign-in: not available in this app');
          return;
        }
        if (!hostedPageShown()) {
          log('refused provider sign-in while the hosted page is not shown');
          return;
        }
        if (state.leg) {
          log('refused provider sign-in: one is already in progress');
          return;
        }
        const path = resolveDeepLink(payload && payload.url, host());
        if (path === null) {
          log('refused provider sign-in outside the application host');
          return;
        }
        legCount += 1;
        state.leg = { id: legCount, phase: 'starting', originUrl: state.pageUrl };
        try {
          await native.call('startProviderSignIn', { path: path, leg: legCount });
        } catch (error) {
          failLeg(error);
        }
      },
      providerRedirect: async function (payload) {
        const leg = activeLeg(payload);
        if (!leg || leg.phase !== 'starting') {
          log('ignored a provider redirect without a pending sign-in');
          return;
        }
        if (typeof payload.url !== 'string' || !/^https:\/\//i.test(payload.url)) {
          failLeg('the provider redirect is not https');
          return;
        }
        leg.phase = 'webAuth';
        try {
          await native.call('openWebAuth', {
            url: payload.url,
            callbackHost: host(),
            callbackPath: webAuth.exchangePath(state.applicationId),
            leg: leg.id,
          });
        } catch (error) {
          if (state.leg === leg) {
            failLeg(error);
          }
        }
      },
      webAuthReturned: async function (payload) {
        const leg = activeLeg(payload);
        if (!leg || (leg.phase !== 'webAuth' && leg.phase !== 'closing')) {
          log('ignored a web-authentication return without an open session');
          return;
        }
        if (webAuth.isCallbackServiceLink(payload.url, host())) {
          log('ignored an intermediate callback-service link');
          return;
        }
        const path = webAuth.exchangeReturnPath(payload.url, host(), state.applicationId);
        if (path === null) {
          log('ignored an invalid web-authentication return');
          state.leg = null;
          return;
        }
        if (bundled()) {
          redeemBearer(leg, webAuth.bearerExchangePath(path));
          return;
        }
        leg.phase = 'exchanging';
        await native.call('loadHost', { path: path });
      },
      webAuthCancelled: async function (payload) {
        const leg = activeLeg(payload);
        if (leg && (leg.phase === 'webAuth' || leg.phase === 'closing')) {
          state.leg = null;
        }
      },
      webAuthFailed: async function (payload) {
        const leg = activeLeg(payload);
        if (leg && (leg.phase === 'webAuth' || leg.phase === 'closing')) {
          failLeg(payload.message || 'web authentication failed');
        }
      },
      webAuthClosed: async function (payload) {
        const leg = activeLeg(payload);
        if (!leg || leg.phase !== 'webAuth') {
          return;
        }
        leg.phase = 'closing';
        schedule(function () {
          enqueue(function () {
            if (state.leg === leg && leg.phase === 'closing') {
              state.leg = null;
              log('provider sign-in cancelled: the Custom Tab closed without a return');
            }
          });
        }, WEB_AUTH_CLOSE_GRACE_MS);
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
        return enqueue(async function () {
          state.settingsOpen = true;
          state.settingsError = '';
          await readNotifications();
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
          const replay = state.failedUrl && webAuth.isExchangeLink(state.failedUrl, host());
          const path = (!replay && state.failedUrl && pagePath(state.failedUrl)) || '/';
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
          await disablePushBeforeSignOut();
          state.notificationsOn = false;
          if (bundled()) {
            try {
              await native.call('clearSavedSession');
            } catch (error) {
              state.settingsBusy = '';
              state.settingsError = 'Could not remove the saved sign-in: ' + String((error && error.message) || error);
              return settle();
            }
          }
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
          await cancelLeg();
          // The capability stays off until the catalog has been read again for the new session.
          state.catalogProviderSignIn = false;
          await announceCapabilities();
          await settle();
          await native.call('loadHost', { path: '/' });
          if (probeWanted()) {
            void probe();
          }
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
      state.providerSignInSupported = launch.providerSignInSupported === true;
      state.pushSupported = launch.pushSupported === true;
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
      if (probeWanted()) {
        void probe();
      }
    }

    return { start: start, handleEvent: handleEvent, act: act };
  }

  return {
    createController: createController,
    WEB_AUTH_CLOSE_GRACE_MS: WEB_AUTH_CLOSE_GRACE_MS,
    PUSH_DISABLE_TIMEOUT_MS: PUSH_DISABLE_TIMEOUT_MS,
  };
});
