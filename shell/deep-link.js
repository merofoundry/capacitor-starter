/*
 * Deep-link validation. A link opens in the shell only when it is an https URL on exactly the
 * configured application host; anything else is ignored. The result is a path that the
 * native side appends to https://<host>, so it can never name another origin. In bundled mode
 * a page of the packaged site is recognised by the local origin the native side reports. A
 * notification's tap path is checked against the same absolute-path rule and length limit the
 * platform applies to a push notification's path before the shell navigates to it.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.MeroShell = Object.assign(root.MeroShell || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PUSH_PATH_MAX_LENGTH = 1024;
  // Parsing base for paths only; nothing is ever loaded from it.
  const PATH_BASE = 'https://path.invalid';

  /**
   * @param {unknown} rawUrl
   * @param {string} host
   * @returns {string | null} path, query and fragment beginning with "/", or null
   */
  function resolveDeepLink(rawUrl, host) {
    if (typeof rawUrl !== 'string' || !/^https:\/\//i.test(rawUrl)) {
      return null;
    }
    let url;
    try {
      url = new URL(rawUrl);
    } catch (error) {
      return null;
    }
    if (url.protocol !== 'https:' || url.hostname !== host || url.port !== '') {
      return null;
    }
    if (url.username !== '' || url.password !== '') {
      return null;
    }
    const path = url.pathname.replace(/^\/+/, '/');
    const resolved = path + url.search + url.hash;
    return new URL('https://' + host + resolved).hostname === host ? resolved : null;
  }

  /**
   * A page of the bundled site, which the platform serves from its local origin
   * (capacitor://localhost or https://localhost).
   * @param {unknown} rawUrl
   * @param {unknown} localOrigin
   * @returns {string | null} path, query and fragment beginning with "/", or null
   */
  function resolveLocalPage(rawUrl, localOrigin) {
    if (typeof rawUrl !== 'string' || typeof localOrigin !== 'string' || localOrigin === '') {
      return null;
    }
    let url;
    try {
      url = new URL(rawUrl);
    } catch (error) {
      return null;
    }
    if (url.protocol + '//' + url.host !== localOrigin || url.username !== '' || url.password !== '') {
      return null;
    }
    return url.pathname.replace(/^\/+/, '/') + url.search + url.hash;
  }

  /**
   * A notification's tap path: an absolute path on the application (one leading "/", never "//"),
   * at most PUSH_PATH_MAX_LENGTH characters, with no backslash, whitespace or control character.
   * @param {unknown} value
   * @returns {{path: string} | {reason: string}} the path to open, or a fixed rejection reason
   */
  function checkPushPath(value) {
    if (typeof value !== 'string') {
      return { reason: 'not_a_string' };
    }
    if (value.length > PUSH_PATH_MAX_LENGTH) {
      return { reason: 'too_long' };
    }
    if (!/^\/(?![\/\\])/.test(value)) {
      return { reason: 'not_absolute' };
    }
    if (/[\u0000-\u0020\u007f\\]/.test(value)) {
      return { reason: 'invalid_characters' };
    }
    let url;
    try {
      url = new URL(value, PATH_BASE);
    } catch (error) {
      return { reason: 'not_absolute' };
    }
    if (url.origin !== PATH_BASE) {
      return { reason: 'not_absolute' };
    }
    return { path: url.pathname + url.search + url.hash };
  }

  return {
    resolveDeepLink: resolveDeepLink,
    resolveLocalPage: resolveLocalPage,
    checkPushPath: checkPushPath,
    PUSH_PATH_MAX_LENGTH: PUSH_PATH_MAX_LENGTH,
  };
});
