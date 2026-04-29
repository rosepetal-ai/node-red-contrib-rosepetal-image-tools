#!/usr/bin/env bash
# SessionStart hook: announce nodes that still lack a docs/.md or assets GIF.
# Emits Claude Code hook JSON so the missing-doc list shows up at session start.
#
# This is the only script in .claude/. All other validation is agent-driven.
set -euo pipefail

cd "${CLAUDE_PROJECT_DIR:-$(pwd)}"

# Use Node since we already require it for the toolkit.
report=$(node -e '
  const fs = require("fs");
  const path = require("path");

  let pkg;
  try { pkg = require("./package.json"); } catch { process.exit(0); }

  const types = Object.keys((pkg["node-red"] || {}).nodes || {});
  if (!types.length) process.exit(0);

  const docsRoot = "docs/nodes";
  if (!fs.existsSync(docsRoot)) process.exit(0);

  const docs = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".md")) docs.push(entry.name);
    }
  })(docsRoot);

  const assetsRoot = "assets/nodes";
  const gifs = [];
  if (fs.existsSync(assetsRoot)) {
    (function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith("-demo.gif")) gifs.push(entry.name);
      }
    })(assetsRoot);
  }

  const missingDocs = [];
  const missingGifs = [];
  for (const t of types) {
    const name = t.replace(/^rp-/, "");
    if (!docs.includes(name + ".md")) missingDocs.push(name);
    if (!gifs.includes(name + "-demo.gif")) missingGifs.push(name);
  }

  if (!missingDocs.length && !missingGifs.length) process.exit(0);

  const lines = [];
  if (missingDocs.length) lines.push("Nodes still missing docs/<cat>/<name>.md: " + missingDocs.join(", "));
  if (missingGifs.length) lines.push("Nodes still missing assets/nodes/<cat>/<name>-demo.gif: " + missingGifs.join(", "));
  lines.push("Run /document-all-nodes to generate everything autonomously, or /document-node <name> for one.");

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: lines.join("\n")
    }
  }));
' 2>/dev/null || true)

if [ -n "$report" ]; then
  printf '%s\n' "$report"
fi
