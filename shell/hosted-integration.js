/*
 * Hosted-page integration. The native bootstrap injects this file at document start into the
 * application's own pages, preceded by
 *   window.__meroShellConfig = {host, mode, localOrigin, platform, starterVersion};
 * In remote mode it installs only on the configured https host. In bundled mode the site is
 * packaged in the app and served from the platform's local origin (capacitor://localhost on
 * iOS, https://localhost on Android), so it installs only on that origin; host still names the
 * application host the site's API calls reach.
 * It exposes window.MeroFoundryShell, safe-area CSS variables, data-meroshell-action hooks
 * and pull to refresh. Share and haptics go through the official Capacitor plugins via the
 * bridge Capacitor injects into server.url pages; pull to refresh is starter-local: this file
 * recognises the gesture and asks the MeroShell bootstrap to reload, and the shell controller
 * decides whether it may. The hosted site needs no Capacitor dependency of its own.
 *
 * Provider sign-in (ADR 2026-10-16 v2, Ruling 6) is off until the shell says otherwise: the page
 * asks MeroShell.capabilities once at install, and the shell announces later changes through
 * _setProviderSignIn. While it is on, the root element carries
 * data-meroshell-provider-sign-in="on", MeroFoundryShell.capabilities.providerSignIn is true and
 * a click on a [data-provider-sign-in] link hands its href to the shell instead of navigating.
 * While it is off, nothing is bound and providerSignIn() rejects.
 *
 * MeroFoundryShell.session keeps the bearer token pair (ADR 2026-10-16 v2, Ruling 5) in the
 * device's secure storage: load() answers {accessToken, refreshToken} or null, save(pair) and
 * clear() answer undefined. The tokens go only to the MeroShell bootstrap; nothing here logs,
 * dispatches or stores them. MeroFoundryShell.bearer is shell/bearer-client.js, which the
 * bootstrap injects just before this file: login, fetch, logout and signedIn over that pair.
 * When a provider sign-in completes in bundled mode, the shell saves the pair itself and calls
 * _sessionChanged once the return page has loaded; the page then receives a meroshell:session
 * event whose detail is only {signedIn: true}.
 *
 * MeroFoundryShell.push (ADR 2026-10-16 v2, Rulings 1 to 3 and section 3.3) registers this
 * device for the application's push notifications with the page's own consumer session: the
 * page's cookies and X-Requested-With in remote mode, MeroFoundryShell.bearer.fetch in bundled
 * mode. enable() asks native code for permission and a token (registerPush), then PUTs
 * {token, platform, app_version, locale} to the application's push devices route; disable()
 * has native code delete the token (unregisterPush) and DELETEs that registration; state()
 * answers {enabled, permission, platform}. The application id is the one the shell read from
 * the host (native getPushState, then _setApplicationId), the app version is the native one and
 * the locale is navigator.language. While push is enabled the page renews the registration at
 * ready once per app launch and on a resume a day or more after the last one, and native token
 * refreshes (_pushToken) take the same path. A registration that lacks the application id or a
 * session waits and resumes when either arrives. Every operation runs one at a time in call
 * order, and disable() cancels every registration queued before it, so nothing re-registers
 * after a disable or sign-out. Push tokens are never logged, dispatched or stored here.
 */
(function (root, factory) {
  // In the page the bootstrap has just run bearer-client.js, which left its factory here.
  const bearerClient = root.__meroShellBearerClient || require('./bearer-client.js');
  delete root.__meroShellBearerClient;
  const api = factory(bearerClient);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined' && window.__meroShellConfig) {
    api.install(window, window.__meroShellConfig);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (bearerClient) {
  'use strict';

  const INSET_PROPERTIES = {
    top: '--meroshell-safe-area-inset-top',
    right: '--meroshell-safe-area-inset-right',
    bottom: '--meroshell-safe-area-inset-bottom',
    left: '--meroshell-safe-area-inset-left',
  };
  const HAPTIC_STYLES = ['LIGHT', 'MEDIUM', 'HEAVY'];
  const STATUS_BAR_STYLES = ['DARK', 'LIGHT', 'DEFAULT'];
  const PULL_THRESHOLD = 72;
  const PULL_SLOP = 10;
  const PULL_DISTANCE_PROPERTY = '--meroshell-pull-distance';
  const PULL_STATE_ATTRIBUTE = 'data-meroshell-pull';
  const PULL_OPT_OUT = '[data-meroshell-pull-refresh="off"]';
  const PROVIDER_SIGN_IN_SELECTOR = '[data-provider-sign-in]';
  const PROVIDER_SIGN_IN_ATTRIBUTE = 'data-meroshell-provider-sign-in';
  const PROVIDER_SIGN_IN_UNAVAILABLE = 'Provider sign-in is not available in this app';
  const PROVIDER_SIGN_IN_OFF_HOST = 'Provider sign-in needs a link on this application host';
  const SESSION_PAIR_REQUIRED = 'session.save needs a non-empty accessToken and refreshToken';
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const CSRF_HEADER = 'X-Requested-With';
  const CSRF_VALUE = 'XMLHttpRequest';
  const PUSH_RENEW_MS = 24 * 60 * 60 * 1000;
  const PUSH_RENEWED_KEY = 'meroshell.push.renewedAt';
  const PUSH_EVENT = 'meroshell:push';
  const PUSH_REJECTIONS = ['not_a_string', 'too_long', 'not_absolute', 'invalid_characters'];

  /** True when the page is a document the shell may integrate with in the configured mode. */
  function allowedOrigin(win, config) {
    const location = win.location;
    if (config.mode === 'bundled') {
      return typeof config.localOrigin === 'string' && config.localOrigin !== '' &&
        location.protocol + '//' + location.host === config.localOrigin;
    }
    return location.protocol === 'https:' && location.hostname === config.host;
  }

  /** @returns {boolean} whether `value` is a non-empty string */
  function filled(value) {
    return typeof value === 'string' && value.length > 0;
  }

  /**
   * @param {any} win
   * @param {any} doc
   * @returns {number} how far the page is scrolled down from its top, never negative
   */
  function pageScrollTop(win, doc) {
    const scroller = doc.scrollingElement || doc.documentElement;
    return Math.max(win.scrollY || 0, (scroller && scroller.scrollTop) || 0);
  }

  /** True when the touch starts inside an element that is itself scrolled away from its top. */
  function insideScrolledElement(target) {
    for (let el = target; el && el.nodeType === 1; el = el.parentElement) {
      if (el.scrollTop > 0) {
        return true;
      }
    }
    return false;
  }

  /**
   * Pull-to-refresh gesture recogniser. A pull is eligible only when it starts with one finger
   * while the page is scrolled to the very top, outside any scrolled inner element and outside
   * any element marked data-meroshell-pull-refresh="off". It fires once the finger has moved
   * PULL_THRESHOLD pixels down, more vertically than sideways, and is lifted there.
   *
   * @param {any} win
   * @param {{refresh: () => Promise<any>, armed?: () => void}} actions
   */
  function createPullToRefresh(win, actions) {
    const doc = win.document;
    const html = doc.documentElement;
    let start = null;
    let distance = 0;
    let armed = false;
    let refreshing = false;

    function setState(value) {
      if (value) {
        html.setAttribute(PULL_STATE_ATTRIBUTE, value);
      } else if (typeof html.removeAttribute === 'function') {
        html.removeAttribute(PULL_STATE_ATTRIBUTE);
      }
    }

    function reset() {
      start = null;
      distance = 0;
      armed = false;
      html.style.setProperty(PULL_DISTANCE_PROPERTY, '0px');
      setState(refreshing ? 'refreshing' : null);
    }

    function eligible(event) {
      if (refreshing || !event.touches || event.touches.length !== 1 || doc.visibilityState === 'hidden') {
        return false;
      }
      if (pageScrollTop(win, doc) > 0) {
        return false;
      }
      const target = event.target;
      if (target && typeof target.closest === 'function' && target.closest(PULL_OPT_OUT)) {
        return false;
      }
      return !insideScrolledElement(target);
    }

    function onStart(event) {
      reset();
      if (eligible(event)) {
        start = { x: event.touches[0].clientX, y: event.touches[0].clientY };
      }
    }

    function onMove(event) {
      if (!start) {
        return;
      }
      const touch = event.touches && event.touches.length === 1 ? event.touches[0] : null;
      const dy = touch ? touch.clientY - start.y : 0;
      const dx = touch ? Math.abs(touch.clientX - start.x) : 0;
      if (!touch || (dx > PULL_SLOP && dx >= dy) || (dy < -PULL_SLOP) || pageScrollTop(win, doc) > 0) {
        reset();
        return;
      }
      distance = Math.max(0, dy);
      html.style.setProperty(PULL_DISTANCE_PROPERTY, distance + 'px');
      const nowArmed = distance >= PULL_THRESHOLD;
      if (nowArmed && !armed && actions.armed) {
        actions.armed();
      }
      armed = nowArmed;
      setState(distance > PULL_SLOP ? (armed ? 'armed' : 'pulling') : null);
    }

    function onEnd() {
      const fire = start !== null && armed;
      if (fire) {
        refreshing = true;
      }
      reset();
      if (!fire) {
        return;
      }
      actions.refresh().then(done, done);
    }

    function done() {
      refreshing = false;
      reset();
    }

    const options = { passive: true, capture: true };
    doc.addEventListener('touchstart', onStart, options);
    doc.addEventListener('touchmove', onMove, options);
    doc.addEventListener('touchend', onEnd, options);
    doc.addEventListener('touchcancel', reset, options);
    reset();
  }

  /**
   * Where the last renewal time is kept for this app launch: the WebView's sessionStorage, or an
   * in-memory stand-in when it has none.
   * @returns {{getItem: (key: string) => string | null, setItem: (key: string, value: string) => void, removeItem: (key: string) => void}}
   */
  function launchStorage(win) {
    try {
      if (win.sessionStorage && typeof win.sessionStorage.getItem === 'function') {
        return win.sessionStorage;
      }
    } catch (error) {
      // A WebView that refuses storage gets the in-memory stand-in below.
    }
    const memory = new Map();
    return {
      getItem: function (key) {
        return memory.has(key) ? memory.get(key) : null;
      },
      setItem: function (key, value) {
        memory.set(key, String(value));
      },
      removeItem: function (key) {
        memory.delete(key);
      },
    };
  }

  /**
   * The page's push registration (see the header). Results:
   *   enable(): {status: 'enabled'} | {status: 'denied'} | {status: 'unavailable', reason}
   *     | {status: 'pending', reason: 'application' | 'session'} | {status: 'failed', reason, httpStatus}
   *     | {status: 'cancelled'} when a disable() came first
   *   disable(): {status: 'disabled'} | {status: 'failed', reason, httpStatus}
   *   state(): {enabled, permission, platform}
   *
   * @param {{host: string, bundled: boolean,
   *          native: (method: string, options?: object) => Promise<any>,
   *          fetch: (input: string, init: object) => Promise<Response>,
   *          bearer: {fetch: (input: string, init: object) => Promise<Response>, signedIn: () => Promise<boolean>},
   *          language: () => string, storage: any, now: () => number}} ports
   */
  function createPush(ports) {
    let applicationId = null;
    let generation = 0;
    let waiting = null;
    let chain = Promise.resolve();

    /** Run push operations one at a time, in call order. */
    function serial(task) {
      const run = chain.then(task);
      chain = run.catch(function () {
        // A failed operation answers its own caller; the next one still runs.
      });
      return run;
    }

    function failed(reason, httpStatus) {
      return { status: 'failed', reason: reason, httpStatus: httpStatus || 0 };
    }

    function pending(reason) {
      waiting = reason;
      return { status: 'pending', reason: reason };
    }

    function devicesUrl() {
      return 'https://' + ports.host + '/api/v1/public/applications/' + applicationId + '/push/devices';
    }

    /** A request with the page's consumer session: bearer in bundled mode, cookies in remote mode. */
    function send(method, url, data) {
      const headers = { Accept: 'application/json' };
      headers[CSRF_HEADER] = CSRF_VALUE;
      const init = { method: method, headers: headers, cache: 'no-store' };
      if (data) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify({ data: data });
      }
      if (ports.bundled) {
        init.credentials = 'omit';
        return ports.bearer.fetch(url, init);
      }
      init.credentials = 'include';
      return ports.fetch(url, init);
    }

    /** Bundled mode needs a saved pair; in remote mode only the server can tell, by its answer. */
    async function sessionUsable() {
      if (!ports.bundled) {
        return true;
      }
      try {
        return (await ports.bearer.signedIn()) === true;
      } catch (error) {
        return false;
      }
    }

    async function nativeState() {
      try {
        return (await ports.native('getPushState')) || {};
      } catch (error) {
        return {};
      }
    }

    function renewalDue() {
      const last = Number(ports.storage.getItem(PUSH_RENEWED_KEY));
      return !(last > 0) || ports.now() - last >= PUSH_RENEW_MS;
    }

    /** PUT the device token for the current session, unless a disable() has come since `gen`. */
    async function register(token, platform, gen) {
      if (gen !== generation) {
        return { status: 'cancelled' };
      }
      if (applicationId === null) {
        return pending('application');
      }
      if (!(await sessionUsable())) {
        return pending('session');
      }
      const current = await nativeState();
      if (current.enabled !== true || gen !== generation) {
        return { status: 'cancelled' };
      }
      let response;
      try {
        response = await send('PUT', devicesUrl(), {
          token: token,
          platform: platform,
          app_version: typeof current.appVersion === 'string' ? current.appVersion : '',
          locale: ports.language(),
        });
      } catch (error) {
        return failed('request', 0);
      }
      if (response.status === 401) {
        return pending('session');
      }
      if (!response.ok) {
        return failed('request', response.status);
      }
      waiting = null;
      ports.storage.setItem(PUSH_RENEWED_KEY, String(ports.now()));
      return { status: 'enabled' };
    }

    /** Ask native code for permission (only when undetermined) and the token, then register it. */
    async function obtainAndRegister(gen) {
      if (gen !== generation) {
        return { status: 'cancelled' };
      }
      let result;
      try {
        result = await ports.native('registerPush');
      } catch (error) {
        return { status: 'unavailable', reason: 'bridge' };
      }
      const status = result && result.status;
      if (status === 'denied') {
        return { status: 'denied' };
      }
      if (status !== 'granted' || !filled(result.token)) {
        return { status: 'unavailable', reason: (result && filled(result.reason)) ? result.reason : 'unavailable' };
      }
      return register(result.token, filled(result.platform) ? result.platform : '', gen);
    }

    function enable() {
      const gen = generation;
      return serial(function () {
        return obtainAndRegister(gen);
      });
    }

    /** Re-register while enabled: forced when something it waited for arrived, else when due. */
    function renew(force) {
      const gen = generation;
      return serial(async function () {
        if (gen !== generation || (await nativeState()).enabled !== true) {
          return { status: 'cancelled' };
        }
        if (!force && waiting === null && !renewalDue()) {
          return { status: 'enabled' };
        }
        return obtainAndRegister(gen);
      });
    }

    function disable() {
      generation += 1;
      waiting = null;
      ports.storage.removeItem(PUSH_RENEWED_KEY);
      return serial(async function () {
        let result;
        try {
          result = await ports.native('unregisterPush');
        } catch (error) {
          return failed('native', 0);
        }
        const token = result && filled(result.token) ? result.token : null;
        if (token === null) {
          return { status: 'disabled' };
        }
        if (applicationId === null) {
          return failed('application', 0);
        }
        if (!(await sessionUsable())) {
          return failed('session', 0);
        }
        let response;
        try {
          response = await send('DELETE', devicesUrl() + '/' + encodeURIComponent(token));
        } catch (error) {
          return failed('request', 0);
        }
        if (response.ok || response.status === 404) {
          return { status: 'disabled' };
        }
        return failed('request', response.status);
      });
    }

    async function state() {
      const current = await nativeState();
      return {
        enabled: current.enabled === true,
        permission: filled(current.permission) ? current.permission : 'unavailable',
        platform: filled(current.platform) ? current.platform : '',
      };
    }

    /** Called with the application id the shell read from the host; resumes a waiting registration. */
    function setApplicationId(id) {
      const valid = typeof id === 'string' && UUID.test(id.toLowerCase()) ? id.toLowerCase() : null;
      if (valid === applicationId) {
        return;
      }
      applicationId = valid;
      if (valid !== null && waiting === 'application') {
        renew(true);
      }
    }

    /** A usable session appeared (a bundled sign-in saved its pair). */
    function sessionAvailable() {
      if (waiting === 'session') {
        renew(true);
      }
    }

    /** A native token refresh: the same registration path, never after a disable(). */
    function tokenRefreshed(payload) {
      if (!payload || !filled(payload.token)) {
        return;
      }
      const gen = generation;
      const platform = filled(payload.platform) ? payload.platform : '';
      serial(function () {
        return register(payload.token, platform, gen);
      });
    }

    /** At install: learn the application id native code holds, then renew if push is on. */
    function start() {
      serial(async function () {
        const current = await nativeState();
        if (applicationId === null && typeof current.applicationId === 'string') {
          setApplicationId(current.applicationId);
        }
      });
      renew(false);
    }

    return {
      enable: enable,
      disable: disable,
      state: state,
      renew: renew,
      start: start,
      setApplicationId: setApplicationId,
      sessionAvailable: sessionAvailable,
      tokenRefreshed: tokenRefreshed,
    };
  }

  /**
   * @param {any} win
   * @param {{host: string, mode?: string, localOrigin?: string, platform?: string, starterVersion?: string} | null} config
   */
  function install(win, config) {
    if (!config || !allowedOrigin(win, config)) {
      return null;
    }
    if (win.MeroFoundryShell) {
      return win.MeroFoundryShell;
    }
    const doc = win.document;
    const html = doc.documentElement;

    function nativeCall(plugin, method, options) {
      const cap = win.Capacitor;
      if (!cap || typeof cap.nativePromise !== 'function') {
        return Promise.reject(new Error('Capacitor bridge unavailable'));
      }
      return cap.nativePromise(plugin, method, options || {});
    }

    function applyInsets(insets) {
      Object.keys(INSET_PROPERTIES).forEach(function (side) {
        const value = insets && insets[side];
        if (typeof value === 'number' && isFinite(value) && value >= 0) {
          html.style.setProperty(INSET_PROPERTIES[side], value + 'px');
        }
      });
    }

    function share(options) {
      return nativeCall('Share', 'share', options);
    }

    function haptic(style) {
      const impact = style || 'LIGHT';
      if (HAPTIC_STYLES.indexOf(impact) < 0) {
        return Promise.reject(new Error('unknown haptic style ' + impact));
      }
      return nativeCall('Haptics', 'impact', { style: impact });
    }

    function setStatusBarStyle(style) {
      if (STATUS_BAR_STYLES.indexOf(style) < 0) {
        return Promise.reject(new Error('unknown status bar style ' + style));
      }
      return nativeCall('StatusBar', 'setStyle', { style: style });
    }

    function openSettings() {
      return nativeCall('MeroShell', 'openSettings', {});
    }

    /** Ask the shell to reload this page from the application host. */
    function refresh() {
      return nativeCall('MeroShell', 'refresh', { url: win.location.href });
    }

    function ignore() {}

    /** The stored token pair, or null when none is stored. */
    function loadSession() {
      return nativeCall('MeroShell', 'loadSession', {}).then(function (stored) {
        return stored && filled(stored.accessToken) && filled(stored.refreshToken)
          ? { accessToken: stored.accessToken, refreshToken: stored.refreshToken }
          : null;
      });
    }

    let push = null;

    /** Replace the stored token pair. A push registration waiting for a session resumes. */
    function saveSession(pair) {
      if (!pair || !filled(pair.accessToken) || !filled(pair.refreshToken)) {
        return Promise.reject(new Error(SESSION_PAIR_REQUIRED));
      }
      const tokens = { accessToken: pair.accessToken, refreshToken: pair.refreshToken };
      return nativeCall('MeroShell', 'saveSession', tokens).then(function () {
        if (push) {
          push.sessionAvailable();
        }
        return undefined;
      });
    }

    /** Remove the stored token pair. */
    function clearSession() {
      return nativeCall('MeroShell', 'clearSession', {}).then(function () {
        return undefined;
      });
    }

    let providerSignInEnabled = false;

    /** The sign-in link as an absolute https URL on exactly the configured host, or null. */
    function signInUrl(href) {
      let url;
      try {
        url = new (win.URL || URL)(String(href), win.location.href);
      } catch (error) {
        return null;
      }
      const onHost = url.protocol === 'https:' && url.hostname === config.host && url.port === '' &&
        url.username === '' && url.password === '';
      return onHost ? url.href : null;
    }

    /** Start provider sign-in at a link on this host; the shell runs the provider leg. */
    function providerSignIn(href) {
      if (!providerSignInEnabled) {
        return Promise.reject(new Error(PROVIDER_SIGN_IN_UNAVAILABLE));
      }
      const url = signInUrl(href);
      if (url === null) {
        return Promise.reject(new Error(PROVIDER_SIGN_IN_OFF_HOST));
      }
      return nativeCall('MeroShell', 'providerSignIn', { url: url });
    }

    function onProviderClick(event) {
      const el = event.target && event.target.closest ? event.target.closest(PROVIDER_SIGN_IN_SELECTOR) : null;
      const href = el && (el.href || (typeof el.getAttribute === 'function' && el.getAttribute('href')));
      if (!href) {
        return;
      }
      event.preventDefault();
      providerSignIn(href).catch(ignore);
    }

    /** Called by the shell when the effective capability is known or changes. */
    function setProviderSignIn(enabled) {
      const on = enabled === true;
      if (on === providerSignInEnabled) {
        return;
      }
      providerSignInEnabled = on;
      if (on) {
        html.setAttribute(PROVIDER_SIGN_IN_ATTRIBUTE, 'on');
        doc.addEventListener('click', onProviderClick, true);
      } else {
        html.removeAttribute(PROVIDER_SIGN_IN_ATTRIBUTE);
        doc.removeEventListener('click', onProviderClick, true);
      }
      if (typeof win.CustomEvent === 'function' && typeof win.dispatchEvent === 'function') {
        win.dispatchEvent(new win.CustomEvent('meroshell:capabilities', { detail: { providerSignIn: on } }));
      }
    }

    /** Called by the shell after it changed the saved session; the event carries no token. */
    function sessionChanged(change) {
      const signedIn = Boolean(change && change.signedIn === true);
      if (signedIn && push) {
        push.sessionAvailable();
      }
      if (typeof win.CustomEvent === 'function' && typeof win.dispatchEvent === 'function') {
        win.dispatchEvent(new win.CustomEvent('meroshell:session', { detail: { signedIn: signedIn } }));
      }
    }

    /** Called by the shell before sign-out; reports the outcome to native code, never a token. */
    function pushDisable() {
      return push.disable().then(function (result) {
        return result.status === 'disabled';
      }, function () {
        return false;
      }).then(function (ok) {
        return nativeCall('MeroShell', 'pushDisabled', { ok: ok }).catch(ignore);
      });
    }

    /** Called by the shell for a rejected notification tap: the event carries only the reason. */
    function pushEvent(event) {
      const reason = event && event.type === 'rejected' && PUSH_REJECTIONS.indexOf(event.reason) >= 0 ? event.reason : null;
      if (reason === null || typeof win.CustomEvent !== 'function' || typeof win.dispatchEvent !== 'function') {
        return;
      }
      win.dispatchEvent(new win.CustomEvent(PUSH_EVENT, { detail: { type: 'rejected', reason: reason } }));
    }

    function onClick(event) {
      const el = event.target && event.target.closest ? event.target.closest('[data-meroshell-action]') : null;
      if (!el) {
        return;
      }
      const data = el.dataset;
      if (data.meroshellAction === 'settings') {
        event.preventDefault();
        openSettings().catch(ignore);
      } else if (data.meroshellAction === 'share') {
        event.preventDefault();
        share({ title: data.meroshellShareTitle || doc.title, url: data.meroshellShareUrl || win.location.href }).catch(ignore);
      } else if (data.meroshellAction === 'haptic') {
        haptic(data.meroshellHaptic).catch(ignore);
      }
    }

    Object.keys(INSET_PROPERTIES).forEach(function (side) {
      html.style.setProperty(INSET_PROPERTIES[side], 'env(safe-area-inset-' + side + ', 0px)');
    });
    html.classList.add('meroshell');
    html.setAttribute('data-meroshell-platform', config.platform || 'unknown');
    doc.addEventListener('click', onClick, true);
    createPullToRefresh(win, {
      refresh: refresh,
      armed: function () {
        haptic('LIGHT').catch(ignore);
      },
    });

    if (typeof win.navigator.share !== 'function') {
      win.navigator.share = function (data) {
        const options = {};
        ['title', 'text', 'url'].forEach(function (key) {
          if (data && data[key]) {
            options[key] = data[key];
          }
        });
        return share(options).then(function () {
          return undefined;
        });
      };
    }

    const session = Object.freeze({ load: loadSession, save: saveSession, clear: clearSession });
    const pageFetch = win.fetch;
    const bearer = bearerClient.createBearerClient({
      host: config.host,
      session: session,
      fetch: function (input, init) {
        return pageFetch.call(win, input, init);
      },
      Request: win.Request || Request,
      Headers: win.Headers || Headers,
      baseUrl: function () {
        return win.location.href;
      },
    });
    push = createPush({
      host: config.host,
      bundled: config.mode === 'bundled',
      native: function (method, options) {
        return nativeCall('MeroShell', method, options);
      },
      fetch: function (input, init) {
        return pageFetch.call(win, input, init);
      },
      bearer: bearer,
      language: function () {
        return (win.navigator && typeof win.navigator.language === 'string') ? win.navigator.language : '';
      },
      storage: launchStorage(win),
      now: function () {
        return Date.now();
      },
    });
    const pushApi = Object.freeze({ enable: push.enable, disable: push.disable, state: push.state });

    const api = {
      host: config.host,
      mode: config.mode === 'bundled' ? 'bundled' : 'remote',
      platform: config.platform || 'unknown',
      version: config.starterVersion || '',
      openSettings: openSettings,
      refresh: refresh,
      share: share,
      haptic: haptic,
      setStatusBarStyle: setStatusBarStyle,
      providerSignIn: providerSignIn,
      session: session,
      bearer: bearer,
      push: pushApi,
      _applyInsets: applyInsets,
      _setProviderSignIn: setProviderSignIn,
      _sessionChanged: sessionChanged,
      _setApplicationId: push.setApplicationId,
      _pushToken: push.tokenRefreshed,
      _pushDisable: pushDisable,
      _pushEvent: pushEvent,
    };
    Object.defineProperty(api, 'capabilities', {
      enumerable: true,
      get: function () {
        return Object.freeze({ providerSignIn: providerSignInEnabled });
      },
    });
    Object.freeze(api);
    win.MeroFoundryShell = api;
    if (typeof win.CustomEvent === 'function' && typeof win.dispatchEvent === 'function') {
      win.dispatchEvent(new win.CustomEvent('meroshell:ready', { detail: { platform: api.platform } }));
    }
    nativeCall('MeroShell', 'capabilities', {}).then(function (result) {
      setProviderSignIn(Boolean(result && result.providerSignIn === true));
    }, ignore);
    push.start();
    doc.addEventListener('visibilitychange', function () {
      if (doc.visibilityState === 'visible') {
        push.renew(false);
      }
    });
    return api;
  }

  return {
    install: install,
    createPullToRefresh: createPullToRefresh,
    createPush: createPush,
    PUSH_RENEW_MS: PUSH_RENEW_MS,
    INSET_PROPERTIES: INSET_PROPERTIES,
    PULL_THRESHOLD: PULL_THRESHOLD,
  };
});
