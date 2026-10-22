/*
 * Bearer consumer sessions for a bundled site (ADR 2026-10-16 v2, Ruling 5). The native bootstrap
 * injects this file immediately before hosted-integration.js, which exposes the client as
 * MeroFoundryShell.bearer:
 *   login(modelId, {email, password}) submits the login model with data.session = "bearer" and
 *     X-Requested-With, and saves the returned pair through MeroFoundryShell.session;
 *   fetch(input, init) sends Authorization: Bearer from the saved pair to the application host
 *     and, after a 401, refreshes by body once, saves the rotated pair and retries once;
 *   logout(modelId) submits the logout model with the bearer and clears the saved pair;
 *   signedIn() answers whether a pair is saved.
 * The application UUID the routes need is read from the host's public by-host metadata, never
 * taken from the native app id. Nothing here reads cookies, refreshes in the background, queues
 * requests or keeps responses, and no token is logged, dispatched or returned to the caller.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.__meroShellBearerClient = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const BY_HOST_PATH = '/api/v1/applications/public/by-host';
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const CSRF_HEADER = 'X-Requested-With';
  const CSRF_VALUE = 'XMLHttpRequest';
  // A refresh the server refuses ends the session; anything else (an outage) keeps the pair.
  const REFRESH_REFUSED = [400, 401, 403];

  /** A failed bearer call. It carries the HTTP status and the server's detail, never a token. */
  class BearerError extends Error {
    /**
     * @param {string} message
     * @param {number} status 0 when no response arrived
     * @param {string} code the server's detail, or a fixed local reason
     */
    constructor(message, status, code) {
      super(message);
      this.name = 'BearerError';
      this.status = status;
      this.code = code;
    }
  }

  /** @returns {boolean} whether `value` is a non-empty string */
  function filled(value) {
    return typeof value === 'string' && value.length > 0;
  }

  /** @returns {Promise<any>} the response's JSON body, or null when it has none */
  async function jsonBody(response) {
    try {
      return await response.json();
    } catch (error) {
      return null;
    }
  }

  /** @returns {{accessToken: string, refreshToken: string} | null} the pair in a response body */
  function readPair(body) {
    return body && filled(body.accessToken) && filled(body.refreshToken)
      ? { accessToken: body.accessToken, refreshToken: body.refreshToken }
      : null;
  }

  /** @returns {Promise<BearerError>} the error a non-2xx answer stands for */
  async function failure(operation, response) {
    const body = await jsonBody(response);
    const code = body && typeof body.detail === 'string' ? body.detail : '';
    return new BearerError(operation + ' failed with ' + response.status, response.status, code);
  }

  /**
   * @param {{host: string,
   *          fetch: (input: any, init?: any) => Promise<Response>,
   *          session: {load: () => Promise<any>, save: (pair: object) => Promise<void>, clear: () => Promise<void>},
   *          Request: typeof Request,
   *          Headers: typeof Headers,
   *          baseUrl: () => string}} ports
   */
  function createBearerClient(ports) {
    const origin = 'https://' + ports.host;
    let applicationId = null;
    let refreshing = null;

    function send(url, init) {
      return ports.fetch(url, Object.assign({ credentials: 'omit', cache: 'no-store' }, init));
    }

    function jsonPost(path, data, headers) {
      return send(origin + path, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json', Accept: 'application/json' }, headers),
        body: JSON.stringify({ data: data }),
      });
    }

    /** The application UUID from the host's public metadata, read once per page. */
    async function application() {
      if (applicationId !== null) {
        return applicationId;
      }
      let response;
      try {
        response = await send(origin + BY_HOST_PATH, { headers: { Accept: 'application/json' } });
      } catch (error) {
        throw new BearerError('the application host could not be reached', 0, 'unreachable');
      }
      const body = response.ok ? await jsonBody(response) : null;
      const id = body && typeof body.id === 'string' ? body.id.toLowerCase() : '';
      if (!UUID.test(id)) {
        throw new BearerError('the application id could not be validated', response.status, 'unknown_application');
      }
      applicationId = id;
      return id;
    }

    /** @returns {Promise<string>} the records route of a submission model on the host */
    async function recordsPath(modelId) {
      requireModelId(modelId);
      return '/api/v1/models/' + modelId.toLowerCase() + '/records?application_id=' + (await application());
    }

    function requireModelId(modelId) {
      if (!filled(modelId) || !UUID.test(modelId.toLowerCase())) {
        throw new BearerError('a model id must be a UUID', 0, 'invalid_model');
      }
    }

    /** Sign in with the login model's credentials and save the returned pair. */
    async function login(modelId, credentials) {
      const email = credentials && credentials.email;
      const password = credentials && credentials.password;
      if (!filled(email) || !filled(password)) {
        throw new BearerError('login needs an email and a password', 0, 'invalid_credentials');
      }
      const response = await jsonPost(
        await recordsPath(modelId),
        { email: email, password: password, session: 'bearer' },
        { [CSRF_HEADER]: CSRF_VALUE },
      );
      if (!response.ok) {
        throw await failure('login', response);
      }
      const body = await jsonBody(response);
      const pair = readPair(body);
      if (pair === null) {
        throw new BearerError('login answered without a bearer session', response.status, 'malformed_response');
      }
      await ports.session.save(pair);
      return { redirect: body && typeof body.redirect === 'string' ? body.redirect : null };
    }

    /** True when `request` goes to exactly the application host. */
    function toHost(request) {
      try {
        return new URL(request.url).origin === origin;
      } catch (error) {
        return false;
      }
    }

    function withBearer(request, accessToken) {
      const headers = new ports.Headers(request.headers);
      headers.set('Authorization', 'Bearer ' + accessToken);
      return new ports.Request(request.clone(), { headers: headers });
    }

    /** Rotate the pair by body. Concurrent 401s for the same pair share one refresh. */
    function refresh(pair) {
      if (refreshing === null || refreshing.from !== pair.refreshToken) {
        const run = rotate(pair).finally(function () {
          if (refreshing && refreshing.run === run) {
            refreshing = null;
          }
        });
        refreshing = { from: pair.refreshToken, run: run };
      }
      return refreshing.run;
    }

    /** @returns {Promise<{accessToken: string, refreshToken: string} | null>} the rotated pair */
    async function rotate(pair) {
      let response;
      try {
        const id = await application();
        response = await jsonPost('/api/v1/applications/' + id + '/auth/refresh', { refresh_token: pair.refreshToken });
      } catch (error) {
        return null;
      }
      if (REFRESH_REFUSED.indexOf(response.status) >= 0) {
        await ports.session.clear();
        return null;
      }
      const rotated = response.ok ? readPair(await jsonBody(response)) : null;
      if (rotated !== null) {
        await ports.session.save(rotated);
      }
      return rotated;
    }

    /**
     * fetch() with the saved bearer for requests to the application host. Without a saved pair,
     * and for any other origin, the request goes out exactly as given.
     */
    async function bearerFetch(input, init) {
      const request = new ports.Request(
        typeof input === 'string' || input instanceof URL ? new URL(String(input), ports.baseUrl()).href : input,
        init,
      );
      const pair = toHost(request) ? await ports.session.load() : null;
      if (pair === null) {
        return ports.fetch(request);
      }
      const response = await ports.fetch(withBearer(request, pair.accessToken));
      if (response.status !== 401) {
        return response;
      }
      const rotated = await refresh(pair);
      return rotated === null ? response : ports.fetch(withBearer(request, rotated.accessToken));
    }

    /** Revoke the saved session on the server, then clear the pair whatever the answer. */
    async function logout(modelId) {
      requireModelId(modelId);
      const pair = await ports.session.load();
      let revoked = false;
      try {
        if (pair !== null) {
          const response = await jsonPost(await recordsPath(modelId), {}, {
            Authorization: 'Bearer ' + pair.accessToken,
            [CSRF_HEADER]: CSRF_VALUE,
          });
          revoked = response.ok;
        }
      } catch (error) {
        revoked = false;
      } finally {
        await ports.session.clear();
      }
      return { revoked: revoked };
    }

    /** True when a pair is saved. */
    async function signedIn() {
      return (await ports.session.load()) !== null;
    }

    return Object.freeze({ login: login, fetch: bearerFetch, logout: logout, signedIn: signedIn });
  }

  return { createBearerClient: createBearerClient, BearerError: BearerError };
});
