#!/usr/bin/env node
/**
 * Version sync (CI + local use)
 *
 * Stamps a single version across every PUBLISHED package.json so a release
 * only needs ONE source of truth — the git tag. No more hand-editing.
 *
 * Updates:
 *   - package.json (root)       → "version"
 *   - package.json (root)       → every "@rosepetal/node-red-contrib-image-tools-*"
 *                                 pin under optionalDependencies (must match exactly,
 *                                 or npm resolves the wrong / missing prebuilt binary)
 *   - npm/<arch>/package.json    → "version"  (all platform packages)
 *
 * Does NOT touch rosepetal-image-engine/package.json (private: true, internal build).
 *
 * Version source (priority order):
 *   1. CLI arg:             node scripts/sync-version.js 1.6.0
 *   2. env GITHUB_REF tag:  refs/tags/v1.6.0  → 1.6.0   (how CI passes it)
 *   3. fallback:            current root "version" (idempotent re-stamp)
 *
 * Edits are surgical (regex on the version string only) so unrelated formatting
 * stays byte-for-byte identical — running it twice with the same version is a no-op.
 *
 * Usage: node scripts/sync-version.js [version] [--dry-run]
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DRY_RUN = process.argv.includes('--dry-run');
const PLATFORM_PREFIX = '@rosepetal/node-red-contrib-image-tools-';
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/;

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Resolve the target version from CLI arg, the git tag, or the current root value.
function resolveVersion() {
  const arg = process.argv.slice(2).find((a) => !a.startsWith('-'));
  if (arg) return arg.replace(/^v/, '');

  const tag = (process.env.GITHUB_REF || '').match(/^refs\/tags\/v?(.+)$/);
  if (tag) return tag[1];

  return require(path.join(ROOT, 'package.json')).version;
}

// Replace the FIRST top-level "version": "<digit...>". The leading-digit guard
// skips node-red's "version": ">=1.0.0" (and any other range-style field).
function setTopLevelVersion(content, version) {
  return content.replace(/("version":\s*")\d[^"]*(")/, `$1${version}$2`);
}

// Replace the value of a specific dependency key (e.g. an optionalDependencies pin).
function setDepVersion(content, dep, version) {
  const re = new RegExp(`("${escapeRegex(dep)}":\\s*")[^"]*(")`);
  return content.replace(re, `$1${version}$2`);
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

const version = resolveVersion();
if (!SEMVER.test(version)) {
  console.error(`✗ "${version}" is not a valid semver version`);
  process.exit(1);
}

console.log(`=== Sync version → ${version} ===`);
if (DRY_RUN) console.log('(dry run — no files written)\n');
else console.log('');

let count = 0;

function applyEdit(absFile, label, transform) {
  const before = fs.readFileSync(absFile, 'utf8');
  const after = transform(before);
  if (!DRY_RUN) fs.writeFileSync(absFile, after);
  const changed = after !== before;
  console.log(`  ${changed ? '✓' : '·'} ${label}${changed ? '' : ' (already current)'}`);
  count++;
}

// 1. root package.json: version + every platform pin in optionalDependencies
const rootFile = path.join(ROOT, 'package.json');
const rootPkg = JSON.parse(fs.readFileSync(rootFile, 'utf8'));
const pins = Object.keys(rootPkg.optionalDependencies || {}).filter((d) =>
  d.startsWith(PLATFORM_PREFIX),
);
applyEdit(rootFile, `package.json  (version + ${pins.length} optionalDependencies)`, (content) => {
  content = setTopLevelVersion(content, version);
  for (const dep of pins) content = setDepVersion(content, dep, version);
  return content;
});

// 2. every npm/<arch>/package.json
const npmDir = path.join(ROOT, 'npm');
for (const arch of fs.readdirSync(npmDir).sort()) {
  const file = path.join(npmDir, arch, 'package.json');
  if (!fs.existsSync(file)) continue;
  applyEdit(file, `npm/${arch}/package.json`, (content) => setTopLevelVersion(content, version));
}

console.log(`\nDone — ${count} package.json file(s) at ${version}.`);
if (DRY_RUN) console.log('(dry run — re-run without --dry-run to apply.)');
