/*
 * Hosted-page integration. The native bootstrap injects this file at document start into the
 * application's own pages (and only on its configured https host), preceded by
 *   window.__meroShellConfig = {host, platform, starterVersion};
 * It exposes window.MeroFoundryShell, safe-area CSS variables, data-meroshell-action hooks
 * and pull to refresh. Share and haptics go through the official Capacitor plugins via the
 * bridge Capacitor injects into server.url pages; pull to refresh is starter-local: this file
 * recognises the gesture and asks the MeroShell bootstrap to reload, and the shell controller
 * decides whether it may. The hosted site needs no Capacitor dependency of its own.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined' && window.__meroShellConfig) {
    api.install(window, window.__meroShellConfig);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
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
   * @param {any} win
   * @param {{host: string, platform?: string, starterVersion?: string} | null} config
   */
  function install(win, config) {
    if (!config || win.location.protocol !== 'https:' || win.location.hostname !== config.host) {
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

    const api = Object.freeze({
      host: config.host,
      platform: config.platform || 'unknown',
      version: config.starterVersion || '',
      openSettings: openSettings,
      refresh: refresh,
      share: share,
      haptic: haptic,
      setStatusBarStyle: setStatusBarStyle,
      _applyInsets: applyInsets,
    });
    win.MeroFoundryShell = api;
    if (typeof win.CustomEvent === 'function' && typeof win.dispatchEvent === 'function') {
      win.dispatchEvent(new win.CustomEvent('meroshell:ready', { detail: { platform: api.platform } }));
    }
    return api;
  }

  return {
    install: install,
    createPullToRefresh: createPullToRefresh,
    INSET_PROPERTIES: INSET_PROPERTIES,
    PULL_THRESHOLD: PULL_THRESHOLD,
  };
});
