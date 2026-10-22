'use strict';

/**
 * The web assets Capacitor packages (webDir www/), assembled by `npm run web`:
 * - shell/ is copied to www/meroshell/ in both modes;
 * - in bundled mode the already-built customer site is copied unchanged to the www/ root.
 * Nothing is compiled. The meroshell/ namespace belongs to the shell, so a site with a
 * top-level entry of that name is refused.
 *
 * www/meroshell/assembly.json records the mode, the site and the sha256 of every assembled
 * file. A directory is fresh when that record equals the one the current configuration and
 * sources would produce and every listed file has the recorded content; the comparison is by
 * content, never by timestamp.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { WEB_DIR, readStarterConfig } = require('./shell-config.cjs');

const SHELL_DIR = 'shell';
const NAMESPACE = 'meroshell';
const MANIFEST = `${NAMESPACE}/assembly.json`;
const MANIFEST_FORMAT = 1;
const DRIFT_LISTED = 5;

class WebAssetsError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'WebAssetsError';
  }
}

/**
 * Every file under `dir` (following symbolic links), as sorted posix paths relative to it.
 * @param {string} dir
 * @returns {string[]}
 */
function listFiles(dir) {
  const files = [];
  (function walk(relative) {
    for (const name of fs.readdirSync(path.join(dir, relative)).sort()) {
      const child = relative ? `${relative}/${name}` : name;
      if (fs.statSync(path.join(dir, child)).isDirectory()) {
        walk(child);
      } else {
        files.push(child);
      }
    }
  })('');
  return files;
}

/** @param {string} file */
function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * @param {string} siteDir
 * @param {string} site as configured
 */
function refuseNamespaceCollision(siteDir, site) {
  const collision = fs.readdirSync(siteDir).find((name) => name.toLowerCase() === NAMESPACE);
  if (collision) {
    throw new WebAssetsError(
      `site "${site}" has a top-level "${collision}" entry, but ${NAMESPACE}/ is reserved for the shell's own screens; ` +
        'rename it in your site',
    );
  }
}

/**
 * What www/ must contain for the current configuration: each file's source and destination,
 * and the manifest that records them.
 * @param {string} rootDir
 */
function plannedAssembly(rootDir) {
  const starter = readStarterConfig(rootDir);
  const sources = [];
  if (starter.mode === 'bundled') {
    const site = /** @type {string} */ (starter.site);
    const siteDir = path.resolve(rootDir, site);
    refuseNamespaceCollision(siteDir, site);
    for (const file of listFiles(siteDir)) {
      sources.push({ from: path.join(siteDir, file), to: file });
    }
  }
  const shellDir = path.join(rootDir, SHELL_DIR);
  for (const file of listFiles(shellDir)) {
    sources.push({ from: path.join(shellDir, file), to: `${NAMESPACE}/${file}` });
  }
  sources.sort((a, b) => (a.to < b.to ? -1 : 1));
  const files = Object.fromEntries(sources.map(({ from, to }) => [to, sha256(from)]));
  const manifest = {
    format: MANIFEST_FORMAT,
    mode: starter.mode,
    site: starter.mode === 'bundled' ? starter.site : null,
    files,
  };
  return { manifest, sources };
}

/**
 * Assemble www/ from scratch. The configuration and the site are checked before www/ is
 * removed, so a failure leaves the previous assembly in place.
 * @param {{rootDir: string}} options
 * @returns {{mode: string, files: number}}
 */
function prepareWeb({ rootDir }) {
  const { manifest, sources } = plannedAssembly(rootDir);
  const webDir = path.join(rootDir, WEB_DIR);
  fs.rmSync(webDir, { recursive: true, force: true });
  for (const { from, to } of sources) {
    const target = path.join(webDir, to);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(from, target);
  }
  fs.writeFileSync(path.join(webDir, MANIFEST), JSON.stringify(manifest, null, 2) + '\n');
  return { mode: manifest.mode, files: sources.length };
}

/**
 * @param {Record<string, string>} actual
 * @param {Record<string, string>} expected
 * @param {boolean} reportAdded
 * @returns {string[]}
 */
function fileDrift(actual, expected, reportAdded) {
  const drift = [];
  for (const [file, hash] of Object.entries(expected)) {
    if (!(file in actual)) {
      drift.push(`${file} removed`);
    } else if (actual[file] !== hash) {
      drift.push(`${file} changed`);
    }
  }
  if (reportAdded) {
    drift.push(...Object.keys(actual).filter((file) => !(file in expected)).map((file) => `${file} added`));
  }
  return drift;
}

/** @param {string[]} drift */
function summarize(drift) {
  const listed = drift.slice(0, DRIFT_LISTED).join(', ');
  return drift.length > DRIFT_LISTED ? `${listed} and ${drift.length - DRIFT_LISTED} more` : listed;
}

/**
 * @param {any} recorded
 * @param {{mode: string, site: string | null, files: Record<string, string>}} expected
 * @returns {string[]}
 */
function manifestDrift(recorded, expected) {
  const drift = [];
  for (const key of ['format', 'mode', 'site']) {
    if (recorded[key] !== expected[key]) {
      drift.push(`${key} is ${JSON.stringify(recorded[key])}, expected ${JSON.stringify(expected[key])}`);
    }
  }
  const files = recorded.files && typeof recorded.files === 'object' ? recorded.files : {};
  return drift.concat(fileDrift(expected.files, files, true));
}

/**
 * @param {string} dir
 * @returns {Record<string, string>}
 */
function hashTree(dir) {
  return Object.fromEntries(listFiles(dir).filter((file) => file !== MANIFEST).map((file) => [file, sha256(path.join(dir, file))]));
}

/**
 * Whether `dir` holds web assets assembled from the current configuration and sources.
 * `exact` also rejects files the manifest does not list; leave it off for a platform copy,
 * to which Capacitor adds its own files.
 * @param {string} rootDir
 * @param {string} dir
 * @param {{exact: boolean}} options
 * @returns {string | null} why the directory is missing or stale, or null when it is fresh
 */
function assembledAssetsError(rootDir, dir, { exact }) {
  let expected;
  try {
    expected = plannedAssembly(rootDir).manifest;
  } catch (error) {
    return /** @type {Error} */ (error).message;
  }
  const label = path.relative(rootDir, dir) || '.';
  const manifestFile = path.join(dir, MANIFEST);
  if (!fs.existsSync(manifestFile)) {
    return `${label} has no assembled web assets (${MANIFEST} is missing)`;
  }
  let recorded;
  try {
    recorded = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  } catch (error) {
    return `${label}/${MANIFEST} is not valid JSON`;
  }
  const stale = manifestDrift(recorded || {}, expected);
  if (stale.length > 0) {
    return `${label} was assembled from different sources or configuration: ${summarize(stale)}`;
  }
  const tampered = fileDrift(hashTree(dir), expected.files, exact);
  if (tampered.length > 0) {
    return `${label} no longer matches its manifest: ${summarize(tampered)}`;
  }
  return null;
}

module.exports = { MANIFEST, NAMESPACE, WebAssetsError, assembledAssetsError, prepareWeb };
