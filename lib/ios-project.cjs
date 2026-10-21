'use strict';

/**
 * iOS project preparation. ios/ is never committed: `npx cap add ios` generates it on the
 * customer's Mac or the macOS runner, `npx cap sync ios` adds the plugins (the shell bootstrap
 * among them) and the bundled shell pages, and this applies the starter's remaining native
 * customizations to the generated files. Every edit is idempotent, so running it on a
 * prepared project changes nothing.
 */

const fs = require('node:fs');
const path = require('node:path');
const { readStarterConfig } = require('./shell-config.cjs');

const IOS_FILES = {
  infoPlist: path.join('ios', 'App', 'App', 'Info.plist'),
  entitlements: path.join('ios', 'App', 'App', 'App.entitlements'),
  pbxproj: path.join('ios', 'App', 'App.xcodeproj', 'project.pbxproj'),
};
const SYNCED = {
  config: path.join('ios', 'App', 'App', 'capacitor.config.json'),
  packageSwift: path.join('ios', 'App', 'CapApp-SPM', 'Package.swift'),
  pages: path.join('ios', 'App', 'App', 'public'),
};
const BOOTSTRAP_CLASS = 'MeroShellPlugin';
const BOOTSTRAP_PRODUCT = 'MeroshellBootstrap';
const BUNDLED_PAGES = ['index.html', 'hosted-integration.js'];

const ENTITLEMENTS_SETTING = 'CODE_SIGN_ENTITLEMENTS = App/App.entitlements;';
const GUARD_PHASE_ID = '4D5E11A0C0FFEE0000000001';
const GUARD_PHASE_NAME = 'MeroShell release guard';
const GUARD_INPUTS = [
  '$(SRCROOT)/../../starter.config.json',
  '$(SRCROOT)/../../package.json',
  '$(SRCROOT)/../../scripts/release-guard.cjs',
  '$(SRCROOT)/../../lib/release-guard.cjs',
  '$(SRCROOT)/../../lib/shell-config.cjs',
  '$(SRCROOT)/App/capacitor.config.json',
];

class IosProjectError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'IosProjectError';
  }
}

/** @param {string} text */
function escapeXml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** @param {string} key */
function plistEntry(key) {
  const name = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(<key>${name}</key>\\s*)<string>([^<]*)</string>`);
}

/**
 * @param {string} xml
 * @param {string} key
 * @returns {string | null} the raw (escaped) string value, or null when absent
 */
function readPlistString(xml, key) {
  const match = xml.match(plistEntry(key));
  return match ? match[2] : null;
}

/**
 * Set a top-level string value in an Info.plist, inserting it before the closing </dict>.
 * @param {string} xml
 * @param {string} key
 * @param {string} value unescaped
 */
function setPlistString(xml, key, value) {
  const escaped = escapeXml(value);
  if (plistEntry(key).test(xml)) {
    return xml.replace(plistEntry(key), (_, prefix) => `${prefix}<string>${escaped}</string>`);
  }
  const end = xml.lastIndexOf('</dict>');
  if (end < 0) {
    throw new IosProjectError('Info.plist has no top-level <dict>');
  }
  return `${xml.slice(0, end)}\t<key>${key}</key>\n\t<string>${escaped}</string>\n${xml.slice(end)}`;
}

/**
 * @param {string} host
 * @returns {string}
 */
function entitlementsXml(host) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '\t<key>com.apple.developer.associated-domains</key>',
    '\t<array>',
    `\t\t<string>applinks:${escapeXml(host)}</string>`,
    '\t</array>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/** @param {string} appName */
function faceIdUsage(appName) {
  return `${appName} uses Face ID to unlock the app.`;
}

/**
 * The script of the Xcode build phase. It runs on every build that is not Debug, before the
 * app is compiled, and fails the build when the package-stage release guard does.
 */
function releaseGuardScript() {
  return [
    'if [ "${CONFIGURATION}" != "Debug" ]; then',
    '  export PATH="${PATH}:/opt/homebrew/bin:/usr/local/bin"',
    '  cd "${SRCROOT}/../.." || exit 1',
    '  node scripts/release-guard.cjs --platform ios --stage package || exit 1',
    'fi',
    '',
  ].join('\n');
}

/** Each App target build configuration (Debug and Release), as [start, end) offsets. */
function appTargetConfigurations(pbxproj) {
  const blocks = [];
  const pattern = /\t\t[0-9A-F]{24} \/\* \w+ \*\/ = \{\n\t\t\tisa = XCBuildConfiguration;[\s\S]*?\n\t\t\};/g;
  for (const match of pbxproj.matchAll(pattern)) {
    if (match[0].includes('INFOPLIST_FILE = App/Info.plist;')) {
      blocks.push([match.index, match.index + match[0].length]);
    }
  }
  if (blocks.length === 0) {
    throw new IosProjectError('no App target build configuration in project.pbxproj');
  }
  return blocks;
}

/**
 * Apply `edit` to every App target build configuration block.
 * @param {string} pbxproj
 * @param {(block: string) => string} edit
 */
function editAppConfigurations(pbxproj, edit) {
  let result = '';
  let cursor = 0;
  for (const [start, end] of appTargetConfigurations(pbxproj)) {
    result += pbxproj.slice(cursor, start) + edit(pbxproj.slice(start, end));
    cursor = end;
  }
  return result + pbxproj.slice(cursor);
}

/**
 * @param {string} block
 * @param {string} setting e.g. "PRODUCT_BUNDLE_IDENTIFIER"
 * @param {string} value already quoted when it needs to be
 */
function setBuildSetting(block, setting, value) {
  const line = `${setting} = ${value};`;
  const existing = new RegExp(`${setting} = [^;]*;`);
  if (existing.test(block)) {
    return block.replace(existing, line);
  }
  return block.replace('buildSettings = {\n', `buildSettings = {\n\t\t\t\t${line}\n`);
}

/** @param {string} value */
function pbxString(value) {
  return JSON.stringify(value);
}

function guardPhaseDefinition() {
  const list = (items) => `(\n${items.map((item) => `\t\t\t\t${pbxString(item)},\n`).join('')}\t\t\t)`;
  return [
    '/* Begin PBXShellScriptBuildPhase section */',
    `\t\t${GUARD_PHASE_ID} /* ${GUARD_PHASE_NAME} */ = {`,
    '\t\t\tisa = PBXShellScriptBuildPhase;',
    '\t\t\talwaysOutOfDate = 1;',
    '\t\t\tbuildActionMask = 2147483647;',
    '\t\t\tfiles = (\n\t\t\t);',
    '\t\t\tinputFileListPaths = (\n\t\t\t);',
    `\t\t\tinputPaths = ${list(GUARD_INPUTS)};`,
    `\t\t\tname = ${pbxString(GUARD_PHASE_NAME)};`,
    '\t\t\toutputFileListPaths = (\n\t\t\t);',
    '\t\t\toutputPaths = (\n\t\t\t);',
    '\t\t\trunOnlyForDeploymentPostprocessing = 0;',
    '\t\t\tshellPath = /bin/sh;',
    `\t\t\tshellScript = ${pbxString(releaseGuardScript())};`,
    '\t\t};',
    '/* End PBXShellScriptBuildPhase section */',
    '',
  ].join('\n');
}

/**
 * Add the release guard build phase as the App target's first build phase.
 * @param {string} pbxproj
 */
function addReleaseGuardPhase(pbxproj) {
  if (pbxproj.includes(`${GUARD_PHASE_ID} /* ${GUARD_PHASE_NAME} */ = {`)) {
    return pbxproj;
  }
  const target = /(\/\* App \*\/ = \{\n\t\t\tisa = PBXNativeTarget;[\s\S]*?buildPhases = \(\n)/;
  if (!target.test(pbxproj)) {
    throw new IosProjectError('no App native target in project.pbxproj');
  }
  const anchor = '/* Begin PBXSourcesBuildPhase section */';
  if (!pbxproj.includes(anchor)) {
    throw new IosProjectError('no PBXSourcesBuildPhase section in project.pbxproj');
  }
  return pbxproj
    .replace(target, `$1\t\t\t\t${GUARD_PHASE_ID} /* ${GUARD_PHASE_NAME} */,\n`)
    .replace(anchor, `${guardPhaseDefinition()}\n${anchor}`);
}

/**
 * @param {string} pbxproj
 * @param {{appId: string}} starter
 */
function preparePbxproj(pbxproj, starter) {
  const configured = editAppConfigurations(pbxproj, (block) =>
    setBuildSetting(
      setBuildSetting(block, 'PRODUCT_BUNDLE_IDENTIFIER', starter.appId),
      'CODE_SIGN_ENTITLEMENTS',
      'App/App.entitlements',
    ),
  );
  return addReleaseGuardPhase(configured);
}

/**
 * @param {string} plist
 * @param {{appName: string}} starter
 */
function prepareInfoPlist(plist, starter) {
  const named = setPlistString(plist, 'CFBundleDisplayName', starter.appName);
  return setPlistString(named, 'NSFaceIDUsageDescription', faceIdUsage(starter.appName));
}

/** @param {string} rootDir */
function requireSyncedProject(rootDir) {
  if (!fs.existsSync(path.join(rootDir, IOS_FILES.pbxproj))) {
    throw new IosProjectError('no generated iOS project at ios/App: run npx cap add ios first');
  }
  const sync = 'run npx cap sync ios first';
  const configFile = path.join(rootDir, SYNCED.config);
  if (!fs.existsSync(configFile)) {
    throw new IosProjectError(`${SYNCED.config} is missing: ${sync}`);
  }
  const classes = JSON.parse(fs.readFileSync(configFile, 'utf8')).packageClassList || [];
  if (!classes.includes(BOOTSTRAP_CLASS)) {
    throw new IosProjectError(`the shell bootstrap (${BOOTSTRAP_CLASS}) is not registered in ${SYNCED.config}: ${sync}`);
  }
  const packageSwift = path.join(rootDir, SYNCED.packageSwift);
  if (!fs.existsSync(packageSwift) || !fs.readFileSync(packageSwift, 'utf8').includes(`.product(name: "${BOOTSTRAP_PRODUCT}"`)) {
    throw new IosProjectError(`the shell bootstrap package is not linked in ${SYNCED.packageSwift}: ${sync}`);
  }
  for (const page of BUNDLED_PAGES) {
    if (!fs.existsSync(path.join(rootDir, SYNCED.pages, page))) {
      throw new IosProjectError(`the bundled shell page ${page} is missing from ${SYNCED.pages}: ${sync}`);
    }
  }
}

/**
 * Apply every starter customization to a freshly generated and synced iOS project.
 * @param {{rootDir: string}} options
 * @returns {string[]} the files that changed
 */
function prepareIosProject({ rootDir }) {
  requireSyncedProject(rootDir);
  const starter = readStarterConfig(rootDir);
  const outputs = {
    [IOS_FILES.infoPlist]: (text) => prepareInfoPlist(text, starter),
    [IOS_FILES.entitlements]: () => entitlementsXml(starter.host),
    [IOS_FILES.pbxproj]: (text) => preparePbxproj(text, starter),
  };
  const changed = [];
  for (const [relative, produce] of Object.entries(outputs)) {
    const file = path.join(rootDir, relative);
    const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const after = produce(before);
    if (after !== before) {
      fs.writeFileSync(file, after);
      changed.push(relative);
    }
  }
  return changed;
}

module.exports = {
  IOS_FILES,
  IosProjectError,
  addReleaseGuardPhase,
  entitlementsXml,
  faceIdUsage,
  prepareIosProject,
  readPlistString,
  releaseGuardScript,
  setPlistString,
};
