/*
 * Deep-link validation. A link opens in the shell only when it is an https URL on exactly the
 * configured application host; anything else is ignored. The result is a path that the
 * native side appends to https://<host>, so it can never name another origin.
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

  return { resolveDeepLink: resolveDeepLink };
});
