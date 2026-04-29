---
paths:
  - ".claude/**"
description: |
  How the autonomous-doc system in this repo is wired. Auto-loaded whenever
  Claude touches a file under .claude/. Read this before modifying any skill,
  agent, rule, or settings.
---

# Claude Code conventions for this repo

This `.claude/` directory hosts a self-contained autonomous documentation system. It must remain coherent — adding/removing pieces ad-hoc breaks the orchestration.

## Architecture (do not redesign without notice)

```
skills/document-node/SKILL.md         orchestrates phases 0–5
skills/document-all-nodes/SKILL.md    iterates orphan nodes, calls /document-node
skills/doctor/SKILL.md                runs the validator standalone

agents/doc-env-validator.md           Phase 0  active env probe + self-heal
agents/doc-writer.md                  Phase 2  .md + HTML help block
agents/gif-recorder.md                Phase 3  Node-RED + Chrome DevTools + ffmpeg
agents/doc-reviewer.md                Phase 4  reasoning validator → {ok, fixes}

rules/documentation-conventions.md    paths: docs/nodes/**, nodes/**/*.html, assets/nodes/**
rules/node-implementation-template.md paths: nodes/**/*.{js,html}
rules/claude-code-conventions.md      paths: .claude/**

scripts/announce-orphans.sh           manual probe: prints missing-doc list
```

There is intentionally **no `settings.json`** in this directory. Permissions are user-level (each developer manages their own in `~/.claude/settings.json` or `.claude/settings.local.json`). The autonomous pipeline therefore prompts on each tool call until the user approves or pre-allows them locally.

## Hard rules for changes inside `.claude/`

1. **Skills orchestrate, agents reason.** Each `SKILL.md` body stays under ~200 lines and delegates real work to subagents. Don't push logic into the skill body.
2. **Verification is agent-driven.** The validator (`doc-env-validator`) and the reviewer (`doc-reviewer`) are subagents that *reason*, not shell scripts. If you find yourself writing a `*.sh` to validate documentation, stop — that's the reviewer's job.
3. **No hooks.** Validation is the reviewer agent's job, not a `PostToolUse` linter. The orphan-announcement script in `scripts/announce-orphans.sh` is invocable manually but not wired to any lifecycle event.
4. **All output is English.** Every generated `.md`, every help-block string, every status message produced by the agents is English. The conversation language never leaks into artefacts.
5. **Templates are the single source of truth.** `skills/document-node/templates/node-doc.md.tmpl` and `templates/help-block.html.tmpl` define the canonical structure. Updating documentation conventions means editing those templates plus `rules/documentation-conventions.md` — never one without the other.
6. **Permissions are user-managed.** This repo ships no `settings.json`. Agents only touch `*.html` (help blocks), `docs/`, `assets/`, and the root `README.md`; the system prompts of `doc-writer`, `gif-recorder`, and `doc-reviewer` enforce those boundaries. If you want the pipeline to run without prompts, pre-allow the relevant `Bash(...)` / `Skill(...)` / `Agent(...)` rules in your own `~/.claude/settings.json` or `.claude/settings.local.json`.
7. **Subagents cannot nest subagents.** Phase chaining happens in the orchestrator skill, not by one subagent calling another.
8. **MCPs are the only escape hatch.** When `mcp__node-red__*` or `mcp__chrome-devtools__*` aren't loaded, the validator surfaces the exact `.mcp.json` patch and asks for a Claude Code restart. This is the one place we can't self-heal.

## Anti-patterns

- Writing a `validate-doc.sh` or `precheck.sh` — the user explicitly rejected this. Use agents.
- Inlining the canonical template inside `SKILL.md` — keep it in `templates/`.
- Generating documentation in Spanish or any non-English language.
- Editing `node-red-contrib-image-tools/nodes/**/*.js` from a doc workflow.
- Adding a new node category without also extending the doc-writer's category list and updating `rules/documentation-conventions.md`.

## Adding a new specialist agent

1. Drop the `<name>.md` file under `agents/`. Frontmatter: `description`, `tools` (whitelist), `model: sonnet`.
2. Add an explicit phase in the appropriate skill body, with the prompt the skill should send.
3. Document its role in this file under "Architecture".
