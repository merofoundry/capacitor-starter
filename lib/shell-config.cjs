'use strict';

/**
 * Shell configuration: reads starter.config.json and builds the Capacitor configuration.
 *
 * The shell talks to exactly one HTTPS host. Everything that names that host (server.url,
 * allowNavigation, deep links, the release guard) derives from the value validated here.
 *
 * The mode decides where the main web view's pages come from:
 * - "remote" (the default): the application's hosted site at https://<host>;
 * - "bundled": an already-built copy of the site, `site`, packaged in the app and served from
 *   the platform's local origin, while <host> stays the application host its API calls reach.
 * Both modes package the shell screens under www/meroshell/ (lib/web-assets.cjs).
 */

const fs = require('node:fs');
const path = require('node:path');

const PREVIEW_ENV = 'MEROSHELL_PREVIEW_HOST';
const STARTER_CONFIG_FILE = 'starter.config.json';
const STARTER_KEYS = ['host', 'appId', 'appName', 'mode', 'site'];
const MODES = ['remote', 'bundled'];
const WEB_DIR = 'www';
const USER_AGENT_PRODUCT = 'MeroFoundryShell';

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const APP_ID_SEGMENT = /^[a-zA-Z][a-zA-Z0-9_]*$/;

class ShellConfigError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ShellConfigError';
  }
}

/**
 * Validate a bare application host name: lowercase ASCII, two or more labels, no scheme,
 * port, path, credentials, wildcard or IP literal.
 * @param {unknown} host
 * @param {string} [field]
 * @returns {string} the host, unchanged
 */
function validateHost(host, field = 'host') {
  if (typeof host !== 'string' || host.length === 0) {
    throw new ShellConfigError(`${field} must be a non-empty string such as "app.example.com"`);
  }
  if (host.length > 253) {
    throw new ShellConfigError(`${field} "${host}" is longer than 253 characters`);
  }
  if (host !== host.toLowerCase()) {
    throw new ShellConfigError(`${field} "${host}" must be lowercase`);
  }
  const labels = host.split('.');
  if (labels.length < 2) {
    throw new ShellConfigError(`${field} "${host}" must be a fully qualified host name`);
  }
  for (const label of labels) {
    if (!LABEL.test(label)) {
      throw new ShellConfigError(
        `${field} "${host}" must be a bare host name: letters, digits and inner hyphens only, ` +
          'no scheme, port, path, wildcard or trailing dot',
      );
    }
  }
  if (!/[a-z]/.test(labels[labels.length - 1])) {
    throw new ShellConfigError(`${field} "${host}" must be a host name, not an IP address`);
  }
  return host;
}

/**
 * @param {unknown} appId
 * @returns {string}
 */
function validateAppId(appId) {
  const segments = typeof appId === 'string' ? appId.split('.') : [];
  if (segments.length < 2 || !segments.every((segment) => APP_ID_SEGMENT.test(segment))) {
    throw new ShellConfigError(
      `appId "${String(appId)}" must be a reverse-domain identifier such as "com.example.app"`,
    );
  }
  return /** @type {string} */ (appId);
}

/**
 * @param {unknown} appName
 * @returns {string}
 */
function validateAppName(appName) {
  if (typeof appName !== 'string' || appName.trim().length === 0) {
    throw new ShellConfigError('appName must be a non-empty string');
  }
  return appName;
}

/**
 * @param {unknown} mode
 * @returns {'remote' | 'bundled'}
 */
function validateMode(mode) {
  if (mode === undefined) {
    return 'remote';
  }
  if (!MODES.includes(/** @type {string} */ (mode))) {
    throw new ShellConfigError(`mode ${JSON.stringify(mode)} must be one of ${MODES.map((m) => `"${m}"`).join(', ')}`);
  }
  return /** @type {'remote' | 'bundled'} */ (mode);
}

/**
 * @param {unknown} site
 * @param {'remote' | 'bundled'} mode
 * @returns {string | undefined}
 */
function validateSitePath(site, mode) {
  if (mode === 'remote') {
    if (site !== undefined) {
      throw new ShellConfigError('site is only used when mode is "bundled"; remove it or set "mode": "bundled"');
    }
    return undefined;
  }
  if (typeof site !== 'string' || site.length === 0 || path.isAbsolute(site)) {
    throw new ShellConfigError(
      'site must be a relative path from the starter root to your already-built site, such as "../my-site/dist"',
    );
  }
  return site;
}

/**
 * @typedef {{host: string, appId: string, appName: string, mode: 'remote' | 'bundled', site?: string}} StarterConfig
 */

/**
 * Validate the configuration's values. The bundled site on disk is checked by
 * readStarterConfig, which knows the starter root.
 * @param {unknown} raw
 * @returns {StarterConfig}
 */
function validateStarterConfig(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ShellConfigError(`${STARTER_CONFIG_FILE} must contain a JSON object`);
  }
  const unknown = Object.keys(raw).filter((key) => !STARTER_KEYS.includes(key));
  if (unknown.length > 0) {
    throw new ShellConfigError(`${STARTER_CONFIG_FILE} has unknown key "${unknown[0]}"`);
  }
  const config = /** @type {Record<string, unknown>} */ (raw);
  const mode = validateMode(config.mode);
  const site = validateSitePath(config.site, mode);
  const starter = {
    host: validateHost(config.host),
    appId: validateAppId(config.appId),
    appName: validateAppName(config.appName),
    mode,
  };
  return site === undefined ? starter : { ...starter, site };
}

/**
 * @param {string} parent
 * @param {string} child
 */
function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * The bundled site must be a readable directory with an index.html, and must neither be nor
 * contain nor sit inside the www directory it is assembled into.
 * @param {string} rootDir
 * @param {string} site
 * @returns {string} the site's absolute path
 */
function requireBundledSite(rootDir, site) {
  const siteDir = path.resolve(rootDir, site);
  const webDir = path.resolve(rootDir, WEB_DIR);
  if (isWithin(siteDir, webDir) || isWithin(webDir, siteDir)) {
    throw new ShellConfigError(`site "${site}" overlaps ${WEB_DIR}/, which the starter assembles from it; point site at your built site`);
  }
  let stat;
  try {
    stat = fs.statSync(siteDir);
  } catch (error) {
    throw new ShellConfigError(`site "${site}" cannot be read: build your site first (${/** @type {Error} */ (error).message})`);
  }
  if (!stat.isDirectory()) {
    throw new ShellConfigError(`site "${site}" is not a directory`);
  }
  try {
    fs.accessSync(siteDir, fs.constants.R_OK | fs.constants.X_OK);
    fs.accessSync(path.join(siteDir, 'index.html'), fs.constants.R_OK);
  } catch (error) {
    throw new ShellConfigError(`site "${site}" must be a readable directory containing index.html`);
  }
  return siteDir;
}

/**
 * @param {string} file
 * @returns {unknown}
 */
function readJson(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new ShellConfigError(`cannot read ${file}: ${/** @type {Error} */ (error).message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ShellConfigError(`${file} is not valid JSON: ${/** @type {Error} */ (error).message}`);
  }
}

/**
 * Read and validate starter.config.json, including the bundled site on disk.
 * @param {string} rootDir
 * @returns {StarterConfig}
 */
function readStarterConfig(rootDir) {
  const starter = validateStarterConfig(readJson(path.join(rootDir, STARTER_CONFIG_FILE)));
  if (starter.mode === 'bundled') {
    requireBundledSite(rootDir, /** @type {string} */ (starter.site));
  }
  return starter;
}

/**
 * @param {string} rootDir
 * @returns {string}
 */
function readStarterVersion(rootDir) {
  const pkg = /** @type {{version?: unknown}} */ (readJson(path.join(rootDir, 'package.json')));
  if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
    throw new ShellConfigError('package.json must declare the starter version');
  }
  return pkg.version;
}

/**
 * @param {string} starterVersion
 * @returns {string}
 */
function userAgentFor(starterVersion) {
  return `${USER_AGENT_PRODUCT}/${starterVersion}`;
}

/**
 * Build the Capacitor configuration for the production host, or for a validated preview
 * host when a debug sync passes one. Remote mode loads server.url; bundled mode leaves it out
 * so the app serves www from the local origin. The bootstraps read host and mode from the
 * MeroShell plugin configuration, never from server.url, and the iOS secure store names its
 * Keychain service after appId. Bridge logging is off: Capacitor's
 * debug log prints plugin call data, which would include the session tokens.
 * @param {{starter: unknown, starterVersion: string, previewHost?: string}} options
 * @returns {Record<string, any>}
 */
function buildCapacitorConfig({ starter, starterVersion, previewHost }) {
  const { host, appId, appName, mode } = validateStarterConfig(starter);
  const loadedHost = previewHost ? validateHost(previewHost, PREVIEW_ENV) : host;
  const server = mode === 'remote' ? { url: `https://${loadedHost}` } : {};
  return {
    appId,
    appName,
    webDir: WEB_DIR,
    appendUserAgent: userAgentFor(starterVersion),
    loggingBehavior: 'none',
    server: {
      ...server,
      allowNavigation: [loadedHost],
      cleartext: false,
    },
    android: {
      allowMixedContent: false,
    },
    plugins: {
      MeroShell: {
        starterVersion,
        appId,
        host: loadedHost,
        mode,
      },
      StatusBar: {
        overlaysWebView: true,
        style: 'DEFAULT',
      },
    },
  };
}

/**
 * Entry point used by capacitor.config.ts.
 * @param {{rootDir: string, env: Record<string, string | undefined>}} options
 * @returns {Record<string, any>}
 */
function loadCapacitorConfig({ rootDir, env }) {
  return buildCapacitorConfig({
    starter: readStarterConfig(rootDir),
    starterVersion: readStarterVersion(rootDir),
    previewHost: env[PREVIEW_ENV] || undefined,
  });
}

module.exports = {
  MODES,
  PREVIEW_ENV,
  WEB_DIR,
  ShellConfigError,
  buildCapacitorConfig,
  loadCapacitorConfig,
  readStarterConfig,
  readStarterVersion,
  userAgentFor,
  validateHost,
};
