/*
 * Provider sign-in checks (ADR 2026-10-16 v2, Ruling 6). The shell learns the application id
 * from the public by-host metadata and whether the platform offers provider sign-in from the
 * application catalog; a web-authentication return is accepted only as an HTTPS URL on the
 * configured host whose path is exactly that application's OAuth exchange route. Anything the
 * shell cannot validate counts as "not available": every reader here fails closed. In bundled
 * mode the exchange is asked for the bearer transport and its returnTo must be a same-origin
 * path, which the shell opens in the bundled site.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.MeroShell = Object.assign(root.MeroShell || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const BY_HOST_PATH = '/api/v1/applications/public/by-host';
  const CATALOG_PATH = '/.well-known/api-catalog';
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const EXCHANGE_PATH = /^\/api\/v1\/applications\/[^/]+\/auth\/oauth\/exchange$/;
  const CALLBACK_SERVICE_PATH = /^\/api\/v1\/services\/[0-9a-fA-F-]{36}\/inbound\/?$/;
  // Parsing base for paths only; nothing is ever loaded from it.
  const LOCAL_BASE = 'https://path.invalid';

  /**
   * @param {string} applicationId
   * @returns {string} the application's OAuth exchange route on its own host
   */
  function exchangePath(applicationId) {
    return '/api/v1/applications/' + applicationId + '/auth/oauth/exchange';
  }

  /**
   * @param {unknown} response a {status, body} answer from the native fetchHost command
   * @returns {any} the parsed JSON body of a 200 answer, or null
   */
  function okJson(response) {
    if (!response || response.status !== 200 || typeof response.body !== 'string') {
      return null;
    }
    try {
      return JSON.parse(response.body);
    } catch (error) {
      return null;
    }
  }

  /**
   * @param {unknown} response the by-host metadata answer
   * @returns {string | null} the lowercase application UUID, or null when it cannot be validated
   */
  function readApplicationId(response) {
    const data = okJson(response);
    const id = data && typeof data.id === 'string' ? data.id.toLowerCase() : '';
    return UUID.test(id) ? id : null;
  }

  /**
   * @param {unknown} response the catalog answer
   * @returns {boolean} true only when the catalog says provider sign-in from a shell is on
   */
  function readCatalogProviderSignIn(response) {
    const data = okJson(response);
    const shell = data && typeof data === 'object' ? data.mobile_shell : null;
    return Boolean(shell && typeof shell === 'object' && shell.provider_sign_in === true);
  }

  /**
   * @param {unknown} rawUrl
   * @param {string} host
   * @returns {URL | null} an https URL on exactly the host, default port, no credentials
   */
  function onHost(rawUrl, host) {
    if (typeof rawUrl !== 'string' || !/^https:\/\//i.test(rawUrl)) {
      return null;
    }
    let url;
    try {
      url = new URL(rawUrl);
    } catch (error) {
      return null;
    }
    if (url.protocol !== 'https:' || url.hostname !== host || url.port !== '' || url.username !== '' || url.password !== '') {
      return null;
    }
    return url;
  }

  /**
   * @param {unknown} rawUrl the URL the web-authentication session handed back
   * @param {string} host
   * @param {string | null} applicationId
   * @returns {string | null} the exchange path and actual query to load, or null
   */
  function exchangeReturnPath(rawUrl, host, applicationId) {
    if (typeof applicationId !== 'string' || !UUID.test(applicationId)) {
      return null;
    }
    const url = onHost(rawUrl, host);
    if (!url || url.pathname !== exchangePath(applicationId)) {
      return null;
    }
    return url.pathname + url.search;
  }

  /**
   * The validated exchange path with the bearer transport selected (Ruling 5): session=bearer
   * replaces any session value the return carried.
   * @param {string} path a path answered by exchangeReturnPath
   * @returns {string}
   */
  function bearerExchangePath(path) {
    const url = new URL(path, LOCAL_BASE);
    url.searchParams.set('session', 'bearer');
    return url.pathname + url.search;
  }

  /**
   * @param {unknown} returnTo the returnTo of a bearer exchange answer
   * @returns {string | null} the same-origin path to open in the bundled site, or null
   */
  function localReturnPath(returnTo) {
    if (typeof returnTo !== 'string' || !/^\/(?![\/\\])/.test(returnTo) || /[\u0000-\u001f\\]/.test(returnTo)) {
      return null;
    }
    let url;
    try {
      url = new URL(returnTo, LOCAL_BASE);
    } catch (error) {
      return null;
    }
    return url.origin === LOCAL_BASE ? url.pathname + url.search + url.hash : null;
  }

  /** True for a link to an application callback service: an intermediate step, not a return. */
  function isCallbackServiceLink(rawUrl, host) {
    const url = onHost(rawUrl, host);
    return Boolean(url && CALLBACK_SERVICE_PATH.test(url.pathname));
  }

  /** True for a link to any application's exchange route on the host. */
  function isExchangeLink(rawUrl, host) {
    const url = onHost(rawUrl, host);
    return Boolean(url && EXCHANGE_PATH.test(url.pathname));
  }

  return {
    BY_HOST_PATH: BY_HOST_PATH,
    CATALOG_PATH: CATALOG_PATH,
    exchangePath: exchangePath,
    readApplicationId: readApplicationId,
    readCatalogProviderSignIn: readCatalogProviderSignIn,
    exchangeReturnPath: exchangeReturnPath,
    bearerExchangePath: bearerExchangePath,
    localReturnPath: localReturnPath,
    isCallbackServiceLink: isCallbackServiceLink,
    isExchangeLink: isExchangeLink,
  };
});
