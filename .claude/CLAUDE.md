# Claude config for `@rosepetal/node-red-contrib-image-tools`

This project ships an **autonomous documentation system** built on Claude Code skills, agents, and rules. Use it instead of writing node docs by hand.

## Entry points

- `/document-node <name>` — generate or regenerate docs + GIF for a single node (e.g. `folder-in`, `add-bbs`).
- `/document-all-nodes` — find every node missing docs or a GIF and generate them.
- `/doctor` — run only the environment validator (no generation). Useful before a doc run, or to debug.

## How it works (1-line each)

1. **Skill** `document-node` orchestrates 5 phases.
2. **Agent** `doc-env-validator` actively probes Node-RED, MCP servers, ffmpeg, fixtures, and **self-heals** what it can.
3. **Agent** `doc-writer` produces the `.md` long-form and rewrites the inline HTML help block from canonical templates.
4. **Agent** `gif-recorder` deploys a flow via the node-red MCP, drives Chrome DevTools MCP, and encodes a GIF with ffmpeg.
5. **Agent** `doc-reviewer` reasons over the result and either approves or sends `fixes` back to `doc-writer` (max 2 retries).
6. The skill updates the README node table.

## Hard rules baked into the system

- **All generated docs are in English** regardless of conversation language.
- **Verification is agent-driven**, never a static script. Validators reason and self-heal.
- The autonomous agents must not modify `node-red-contrib-image-tools/lib/**`, `rosepetal-image-engine/src/**`, or `nodes/**/*.js` — only HTML help blocks, `docs/`, `assets/`, and `README.md`.

## Files of interest

- `.claude/skills/` — entry-point skills.
- `.claude/agents/` — the four specialist subagents.
- `.claude/rules/` — path-scoped guidance (auto-loaded when Claude touches matching files).
- `.claude/scripts/announce-orphans.sh` — optional manual probe; run with `bash .claude/scripts/announce-orphans.sh` to see which nodes still lack docs or GIFs.

> **Note**: this repo intentionally does not ship a `.claude/settings.json`. Each user keeps their own permissions in `~/.claude/settings.json` or `.claude/settings.local.json` (gitignored). The autonomous pipeline therefore prompts for permission on each Bash/Edit/Agent call by default — approve them for the session or pre-allow in your local settings.
