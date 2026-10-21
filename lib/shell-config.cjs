'use strict';

/**
 * Shell configuration: reads starter.config.json and builds the Capacitor configuration.
 *
 * The shell loads exactly one HTTPS host. Everything that names that host (server.url,
 * allowNavigation, deep links, the release guard) derives from the value validated here.
 */

const fs = require('node:fs');
const path = require('node:path');

const PREVIEW_ENV = 'MEROSHELL_PREVIEW_HOST';
const STARTER_CONFIG_FILE = 'starter.config.json';
const STARTER_KEYS = ['host', 'appId', 'appName'];
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
 * @param {unknown} raw
 * @returns {{host: string, appId: string, appName: string}}
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
  return {
    host: validateHost(config.host),
    appId: validateAppId(config.appId),
    appName: validateAppName(config.appName),
  };
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
 * @param {string} rootDir
 * @returns {{host: string, appId: string, appName: string}}
 */
function readStarterConfig(rootDir) {
  return validateStarterConfig(readJson(path.join(rootDir, STARTER_CONFIG_FILE)));
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
 * host when a debug sync passes one.
 * @param {{starter: unknown, starterVersion: string, previewHost?: string}} options
 * @returns {Record<string, any>}
 */
function buildCapacitorConfig({ starter, starterVersion, previewHost }) {
  const { host, appId, appName } = validateStarterConfig(starter);
  const loadedHost = previewHost ? validateHost(previewHost, PREVIEW_ENV) : host;
  return {
    appId,
    appName,
    webDir: 'shell',
    appendUserAgent: userAgentFor(starterVersion),
    server: {
      url: `https://${loadedHost}`,
      allowNavigation: [loadedHost],
      cleartext: false,
    },
    android: {
      allowMixedContent: false,
    },
    plugins: {
      MeroShell: {
        starterVersion,
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
    starter: readJson(path.join(rootDir, STARTER_CONFIG_FILE)),
    starterVersion: readStarterVersion(rootDir),
    previewHost: env[PREVIEW_ENV] || undefined,
  });
}

module.exports = {
  PREVIEW_ENV,
  ShellConfigError,
  buildCapacitorConfig,
  loadCapacitorConfig,
  readStarterConfig,
  readStarterVersion,
  userAgentFor,
  validateHost,
};
