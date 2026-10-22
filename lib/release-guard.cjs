'use strict';

/**
 * Release guard. A release may only be built from the production configuration:
 * - stage "workflow": before sync or asset preparation in a release workflow;
 * - stage "package": from the native release entry points (the Gradle release pre-build and
 *   the Xcode Release build phase), against the configuration Capacitor generated.
 * Either stage rejects MEROSHELL_PREVIEW_HOST and an invalid starter.config.json (including a
 * bundled site that cannot be read). The package stage also rejects a generated configuration
 * that was synced with a preview override or no longer matches starter.config.json, and web
 * assets that are missing or stale: www/ must hold exactly what `npm run web` assembles from the
 * current configuration and sources, and the platform's copy must match it (lib/web-assets.cjs
 * compares content, not timestamps).
 */

const fs = require('node:fs');
const path = require('node:path');
const { PREVIEW_ENV, WEB_DIR, buildCapacitorConfig, readStarterConfig, readStarterVersion } = require('./shell-config.cjs');
const { assembledAssetsError } = require('./web-assets.cjs');

const PLATFORMS = ['android', 'ios'];
const STAGES = ['workflow', 'package'];
const GENERATED_CONFIG = {
  android: path.join('android', 'app', 'src', 'main', 'assets', 'capacitor.config.json'),
  ios: path.join('ios', 'App', 'App', 'capacitor.config.json'),
};
const SYNCED_WEB_ASSETS = {
  android: path.join('android', 'app', 'src', 'main', 'assets', 'public'),
  ios: path.join('ios', 'App', 'App', 'public'),
};
const CHECKED_FIELDS = [
  ['appId'],
  ['webDir'],
  ['appendUserAgent'],
  ['loggingBehavior'],
  ['server', 'url'],
  ['server', 'allowNavigation'],
  ['server', 'cleartext'],
  ['android', 'allowMixedContent'],
  ['plugins', 'MeroShell'],
];

/**
 * @param {string} rootDir
 * @param {string} platform
 */
function generatedConfigPath(rootDir, platform) {
  return path.join(rootDir, GENERATED_CONFIG[platform]);
}

function valueAt(object, keys) {
  return keys.reduce((value, key) => (value && typeof value === 'object' ? value[key] : undefined), object);
}

/**
 * @param {string} rootDir
 * @param {string} platform
 * @param {Record<string, any>} expected
 * @returns {string | null}
 */
function staleConfigError(rootDir, platform, expected) {
  const file = generatedConfigPath(rootDir, platform);
  const relative = GENERATED_CONFIG[platform];
  if (!fs.existsSync(file)) {
    return `no generated Capacitor configuration at ${relative}; run npx cap sync ${platform} first`;
  }
  let actual;
  try {
    actual = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return `${relative} is not valid JSON; run npx cap sync ${platform}`;
  }
  const drift = CHECKED_FIELDS.filter((keys) => JSON.stringify(valueAt(actual, keys)) !== JSON.stringify(valueAt(expected, keys)))
    .map((keys) => `${keys.join('.')} is ${JSON.stringify(valueAt(actual, keys))}, expected ${JSON.stringify(valueAt(expected, keys))}`);
  if (drift.length === 0) {
    return null;
  }
  return (
    `${relative} was not generated from the production configuration (${drift.join('; ')}). ` +
    `It was synced with ${PREVIEW_ENV} or is stale: run npx cap sync ${platform} without ${PREVIEW_ENV} before releasing.`
  );
}

/**
 * @param {string} rootDir
 * @param {string} platform
 * @returns {string | null} why the assembled or synced web assets cannot be released
 */
function staleWebAssetsError(rootDir, platform) {
  const assembled = assembledAssetsError(rootDir, path.join(rootDir, WEB_DIR), { exact: true });
  if (assembled) {
    return `${assembled}; run npm run web, then npx cap sync ${platform}`;
  }
  const synced = assembledAssetsError(rootDir, path.join(rootDir, SYNCED_WEB_ASSETS[platform]), { exact: false });
  return synced ? `${synced}; run npx cap sync ${platform}` : null;
}

/**
 * @param {{rootDir: string, env: Record<string, string | undefined>, platform: string, stage: string}} options
 * @returns {string[]} reasons the release must stop; empty when it may proceed
 */
function checkRelease({ rootDir, env, platform, stage }) {
  if (!PLATFORMS.includes(platform)) {
    throw new RangeError(`unknown platform ${platform}`);
  }
  if (!STAGES.includes(stage)) {
    throw new RangeError(`unknown stage ${stage}`);
  }
  const errors = [];
  if (env[PREVIEW_ENV]) {
    errors.push(`${PREVIEW_ENV} is set to "${env[PREVIEW_ENV]}": preview builds are debug-only and cannot be released`);
  }
  let expected;
  try {
    expected = buildCapacitorConfig({ starter: readStarterConfig(rootDir), starterVersion: readStarterVersion(rootDir) });
  } catch (error) {
    errors.push(/** @type {Error} */ (error).message);
    return errors;
  }
  if (stage === 'package') {
    for (const stale of [staleConfigError(rootDir, platform, expected), staleWebAssetsError(rootDir, platform)]) {
      if (stale) {
        errors.push(stale);
      }
    }
  }
  return errors;
}

module.exports = { PLATFORMS, STAGES, checkRelease, generatedConfigPath };
