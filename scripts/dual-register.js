#!/usr/bin/env node
/**
 * Legacy Compatibility Injection Script (CI use)
 *
 * Runs on source files that already use 'rp-' prefixed type names.
 * Adds legacy registrations under the OLD names (without 'rp-' prefix)
 * so existing user flows keep working after upgrading.
 *
 * - Legacy types are hidden from palette (category: 'deprecated')
 * - Legacy template/help blocks are duplicated for old type names
 * - Source code in git stays clean (rp- only)
 * - Run this in CI before npm publish
 *
 * Usage: node scripts/dual-register.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');

const DRY_RUN = process.argv.includes('--dry-run');
const BASE = path.join(__dirname, '..', 'node-red-contrib-image-tools', 'nodes');

// Maps old type name → file path (old name is what gets added as legacy)
const NODES = [
  { oldType: 'image-in',        path: 'io/image-in' },
  { oldType: 'folder-in',       path: 'io/folder-in' },
  { oldType: 'image-out',       path: 'io/image-out' },
  { oldType: 'resize',          path: 'transform/resize' },
  { oldType: 'crop',            path: 'transform/crop' },
  { oldType: 'rotate',          path: 'transform/rotate' },
  { oldType: 'padding',         path: 'transform/padding' },
  { oldType: 'filter',          path: 'transform/filter' },
  { oldType: 'draw',            path: 'transform/draw' },
  { oldType: 'color-convert',   path: 'transform/color-convert' },
  { oldType: 'concat',          path: 'mix/concat' },
  { oldType: 'mosaic',          path: 'mix/mosaic' },
  { oldType: 'advanced-mosaic', path: 'mix/advanced-mosaic' },
  { oldType: 'blend',           path: 'blend/blend' },
  { oldType: 'add-mask',        path: 'blend/add-mask' },
  { oldType: 'add-masks',       path: 'blend/add-masks' },
  { oldType: 'add-bbs',         path: 'blend/add-bbs' },
  { oldType: 'cropBB',          path: 'specialized/cropBB' },
  { oldType: 'image-align',     path: 'specialized/image-align' },
];

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Find the position of the matching closing brace for an opening brace.
 * Handles nested braces, strings (single/double/template), line and block comments.
 */
function findMatchingBrace(content, openPos) {
  let depth = 0;
  for (let i = openPos; i < content.length; i++) {
    const ch = content[i];

    // Skip single-quoted strings
    if (ch === "'") {
      i++;
      while (i < content.length && content[i] !== "'") {
        if (content[i] === '\\') i++;
        i++;
      }
      continue;
    }
    // Skip double-quoted strings
    if (ch === '"') {
      i++;
      while (i < content.length && content[i] !== '"') {
        if (content[i] === '\\') i++;
        i++;
      }
      continue;
    }
    // Skip template literals
    if (ch === '`') {
      i++;
      while (i < content.length && content[i] !== '`') {
        if (content[i] === '\\') i++;
        i++;
      }
      continue;
    }
    // Skip line comments
    if (ch === '/' && i + 1 < content.length && content[i + 1] === '/') {
      i += 2;
      while (i < content.length && content[i] !== '\n') i++;
      continue;
    }
    // Skip block comments
    if (ch === '/' && i + 1 < content.length && content[i + 1] === '*') {
      i += 2;
      while (i < content.length && !(content[i] === '*' && content[i + 1] === '/')) i++;
      i++;
      continue;
    }

    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// ─────────────────────────────────────────────────────────────
// JS: Find registerType('rp-TYPE', C) → add registerType('TYPE', C)
// ─────────────────────────────────────────────────────────────

function addLegacyJs(filePath, oldType) {
  const rpType = 'rp-' + oldType;
  let content = fs.readFileSync(filePath, 'utf8');

  // Find: RED.nodes.registerType('rp-TYPE', Constructor);
  const regex = new RegExp(
    `([ \\t]*)(RED\\.nodes\\.registerType\\s*\\(\\s*['"])${escapeRegex(rpType)}(['"]\\s*,\\s*)(\\w+)(\\s*\\)\\s*;)`,
  );

  const match = content.match(regex);
  if (!match) {
    console.error(`  JS: ✗ Could not find registerType('${rpType}', ...) in ${path.basename(filePath)}`);
    return false;
  }

  const [fullMatch, indent, prefix, midQuote, constructor, suffix] = match;

  // Add legacy registration on the next line
  const legacyLine = `\n${indent}${prefix}${oldType}${midQuote}${constructor}${suffix}  // legacy compat`;

  content = content.replace(fullMatch, fullMatch + legacyLine);

  if (!DRY_RUN) fs.writeFileSync(filePath, content);
  console.log(`  JS:   ✓ Added legacy registerType('${oldType}', ${constructor})`);
  return true;
}

// ─────────────────────────────────────────────────────────────
// HTML: Add legacy registration + duplicate template/help
// ─────────────────────────────────────────────────────────────

function addLegacyHtmlRegistration(content, oldType) {
  const rpType = 'rp-' + oldType;

  // Find: RED.nodes.registerType('rp-TYPE',
  const rtRegex = new RegExp(
    `(RED\\.nodes\\.registerType\\s*\\(\\s*['"])${escapeRegex(rpType)}(['"]\\s*,\\s*)`,
  );
  const rtMatch = content.match(rtRegex);
  if (!rtMatch) {
    console.error(`  HTML: ✗ Could not find registerType('${rpType}') in registration block`);
    return null;
  }

  const rtStart = rtMatch.index;
  const afterComma = rtStart + rtMatch[0].length;

  // Find the opening { of the config object
  let openBrace = afterComma;
  while (openBrace < content.length && content[openBrace] !== '{') openBrace++;
  if (openBrace >= content.length) {
    console.error(`  HTML: ✗ Could not find config object opening brace`);
    return null;
  }

  // Find the matching closing }
  const closeBrace = findMatchingBrace(content, openBrace);
  if (closeBrace === -1) {
    console.error(`  HTML: ✗ Could not match braces for config object`);
    return null;
  }

  // Find the ); that closes the registerType call
  let callEnd = closeBrace + 1;
  while (callEnd < content.length && /\s/.test(content[callEnd])) callEnd++;
  if (callEnd < content.length && content[callEnd] === ')') callEnd++;
  if (callEnd < content.length && content[callEnd] === ';') callEnd++;

  // Extract config object text (already has rp- labels — that's fine for legacy too)
  const configText = content.substring(openBrace, closeBrace + 1);

  // Get indentation of the registerType line
  const lineStart = content.lastIndexOf('\n', rtStart) + 1;
  const indentMatch = content.substring(lineStart, rtStart).match(/^(\s*)/);
  const indent = indentMatch ? indentMatch[1] : '    ';

  // Replace: original registerType → _rpNodeCfg variable + rp-TYPE registration + legacy registration
  const replacement =
    `var _rpNodeCfg = ${configText};\n` +
    `${indent}RED.nodes.registerType('${rpType}', _rpNodeCfg);\n` +
    `${indent}RED.nodes.registerType('${oldType}', Object.assign({}, _rpNodeCfg, { category: 'deprecated' }));`;

  return content.substring(0, rtStart) + replacement + content.substring(callEnd);
}

function addLegacyScriptBlock(content, attrName, oldType) {
  const rpType = 'rp-' + oldType;

  // Find the rp-TYPE block: <script type="text/x-red" data-xxx-name="rp-TYPE"> ... </script>
  const regex = new RegExp(
    `(<script\\s+type="text/(?:x-red|html)"\\s+${escapeRegex(attrName)}=")${escapeRegex(rpType)}(">[\\s\\S]*?</script>)`,
  );

  const match = content.match(regex);
  if (!match) {
    console.error(`  HTML: ✗ Could not find ${attrName}="${rpType}" block`);
    return content;
  }

  const fullBlock = match[0];
  // Create legacy block with old type name (without rp- prefix)
  const legacyBlock = match[1] + oldType + match[2];

  // Append legacy block after the rp-TYPE block
  return content.replace(fullBlock, fullBlock + '\n\n' + legacyBlock);
}

function addLegacyHtml(filePath, oldType) {
  let content = fs.readFileSync(filePath, 'utf8');

  // 1. Add legacy JS registration
  const transformed = addLegacyHtmlRegistration(content, oldType);
  if (transformed === null) return false;
  content = transformed;

  // 2. Duplicate template block for legacy type name
  content = addLegacyScriptBlock(content, 'data-template-name', oldType);

  // 3. Duplicate help block for legacy type name
  content = addLegacyScriptBlock(content, 'data-help-name', oldType);

  if (!DRY_RUN) fs.writeFileSync(filePath, content);
  console.log(`  HTML: ✓ Added legacy registration + template + help for '${oldType}'`);
  return true;
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

console.log('=== Add Legacy Compatibility (CI) ===');
if (DRY_RUN) console.log('(DRY RUN — no files will be modified)\n');
else console.log('');

let jsOk = 0, htmlOk = 0, jsFail = 0, htmlFail = 0;

for (const node of NODES) {
  console.log(`[${node.oldType}]`);
  const jsFile = path.join(BASE, node.path + '.js');
  const htmlFile = path.join(BASE, node.path + '.html');

  if (addLegacyJs(jsFile, node.oldType)) jsOk++;
  else jsFail++;

  if (addLegacyHtml(htmlFile, node.oldType)) htmlOk++;
  else htmlFail++;

  console.log('');
}

console.log('\n=== Summary ===');
console.log(`  JS:   ${jsOk} ok, ${jsFail} failed`);
console.log(`  HTML: ${htmlOk} ok, ${htmlFail} failed`);
if (DRY_RUN) console.log('\n(Dry run — re-run without --dry-run to apply changes)');
else console.log('\nDone! Legacy compatibility added. Ready to publish.');
