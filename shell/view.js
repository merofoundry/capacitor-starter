/*
 * DOM binding for the shell screens in index.html. Each screen is a [data-view] section;
 * text goes into [data-field] elements and buttons report [data-action] to the controller.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.MeroShell = Object.assign(root.MeroShell || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const LOCK_MESSAGES = {
    prompt: 'Unlock to continue.',
    cancelled: 'Unlock was cancelled. Tap Unlock to try again.',
    failed: 'Not recognised. Tap Unlock to try again.',
    lockout: 'Too many attempts. Unlock your device with its passcode, then try again.',
    unavailable: 'Set up Face ID, Touch ID, fingerprint or a passcode on this device to unlock the app.',
  };
  const LOCK_LABELS = {
    faceId: 'Face ID lock',
    touchId: 'Touch ID lock',
    opticId: 'Optic ID lock',
    biometric: 'Biometric lock',
  };
  const INSET_PROPERTIES = {
    top: '--meroshell-safe-area-inset-top',
    right: '--meroshell-safe-area-inset-right',
    bottom: '--meroshell-safe-area-inset-bottom',
    left: '--meroshell-safe-area-inset-left',
  };

  /**
   * @param {Document} doc
   * @param {(action: string, payload: object) => void} onAction
   */
  function createView(doc, onAction) {
    const sections = Array.prototype.slice.call(doc.querySelectorAll('[data-view]'));

    function section(name) {
      return sections.filter(function (el) {
        return el.getAttribute('data-view') === name;
      })[0];
    }

    function setField(el, field, text) {
      Array.prototype.forEach.call(el.querySelectorAll('[data-field="' + field + '"]'), function (node) {
        node.textContent = text == null ? '' : String(text);
      });
    }

    function setDisabled(el, action, disabled) {
      Array.prototype.forEach.call(el.querySelectorAll('[data-action="' + action + '"]'), function (node) {
        node.disabled = Boolean(disabled);
      });
    }

    const renderers = {
      boot: function (el, data) {
        setField(el, 'appName', data.appName || 'Loading');
      },
      privacy: function (el, data) {
        setField(el, 'appName', data.appName || '');
      },
      lock: function (el, data) {
        setField(el, 'appName', data.appName || '');
        setField(el, 'lockMessage', LOCK_MESSAGES[data.status] || LOCK_MESSAGES.failed);
        setDisabled(el, 'unlock', data.status === 'prompt');
      },
      offline: function (el, data) {
        const retrying = data.status === 'retrying';
        setField(el, 'offlineMessage', retrying ? 'Trying again…' : 'The app could not reach its server.');
        setField(el, 'host', data.host || '');
        setDisabled(el, 'retry', retrying);
      },
      settings: function (el, data) {
        ['appName', 'appVersion', 'starterVersion', 'host', 'modeLabel', 'notifications', 'signOutHint'].forEach(function (field) {
          setField(el, field, data[field]);
        });
        setField(el, 'lockLabel', LOCK_LABELS[data.biometryKind] || 'App lock');
        setField(el, 'settingsError', data.error || '');
        const toggle = el.querySelector('[data-action="setLock"]');
        toggle.checked = Boolean(data.lockEnabled);
        toggle.disabled = Boolean(data.busy) || (!data.lockAvailable && !data.lockEnabled);
        setDisabled(el, 'signOut', Boolean(data.busy));
      },
    };

    function show(name, data) {
      sections.forEach(function (el) {
        el.hidden = el.getAttribute('data-view') !== name;
      });
      const el = section(name);
      if (el && renderers[name]) {
        renderers[name](el, data || {});
      }
    }

    function applyInsets(insets) {
      Object.keys(INSET_PROPERTIES).forEach(function (side) {
        doc.documentElement.style.setProperty(INSET_PROPERTIES[side], insets[side] + 'px');
      });
    }

    doc.addEventListener('click', function (event) {
      const el = event.target && event.target.closest ? event.target.closest('[data-action]') : null;
      if (!el || el.getAttribute('type') === 'checkbox' || el.disabled) {
        return;
      }
      onAction(el.getAttribute('data-action'), {});
    });

    doc.addEventListener('change', function (event) {
      const el = event.target;
      if (el && el.getAttribute && el.getAttribute('data-action') === 'setLock') {
        onAction('setLock', { enabled: Boolean(el.checked) });
      }
    });

    return { show: show, applyInsets: applyInsets };
  }

  return { createView: createView };
});
