---
name: document-node
description: |
  Autonomously generate complete documentation for a Node-RED node in
  @rosepetal/node-red-contrib-image-tools. Produces (1) the long-form Markdown
  at docs/nodes/<category>/<name>.md, (2) the inline <script data-help-name>
  block inside the node's HTML, and (3) the demo GIF at
  assets/nodes/<category>/<name>-demo.gif. Coordinates four specialist agents
  through a 5-phase pipeline with active environment validation, self-healing,
  and a reasoning post-review with up to 2 retries. All output is in English.
when_to_use: |
  Trigger phrases: "document <name>", "document the <name> node", "regenerate
  docs for <name>", "fix the docs of <name>", "documentar el nodo <name>",
  "redocument <name>". Argument is the bare node name (without the rp- prefix).
argument-hint: "<node-name> [--force]"
allowed-tools: Read Edit Write Bash Agent Skill
disable-model-invocation: false
---

# /document-node

Orchestrator for the autonomous documentation pipeline. You receive a single argument: the bare node name (e.g. `folder-in`, `add-bbs`, `image-out`). Optional flag `--force` skips the "already documented" early exit.

You drive the pipeline phase-by-phase, delegating to specialist subagents. Each subagent has its own restricted tools and system prompt; you only pass them what they need.

## Phase 0 — Environment validation

Spawn `doc-env-validator` (foreground) with this prompt:

> Run the full environment validation playbook. The target node for this run is `<NAME>` in the `<CATEGORY>` category (the orchestrator will determine the category in Phase 1, you can ignore that here and verify generic prerequisites). Self-heal everything you can. Return your standard JSON contract object as the last line of your response.

If the validator returns `ok: false`, **stop**. Echo its `note` verbatim to the user as the actionable instruction; do not proceed to later phases. Do not try to work around an unreachable MCP — that's the one hard escape hatch.

## Phase 1 — Source extraction (you do this in your own context)

Read the source for the target node:

1. Look up the node in the repo's `package.json` `node-red.nodes` map. The key is `rp-<NAME>`; the value is the relative JS path (e.g. `node-red-contrib-image-tools/nodes/io/folder-in.js`). Derive the **category** from the path (`io`, `transform`, `mix`, `blend`, `specialized`).
2. Read:
   - `node-red-contrib-image-tools/nodes/<cat>/<name>.js`
   - `node-red-contrib-image-tools/nodes/<cat>/<name>.html`
   - `rosepetal-image-engine/src/<name>.cpp` if it exists (some nodes are pure JS)
   - The closest sibling `.md` in `docs/nodes/<cat>/` to use as a tone anchor (any existing `.md` in the same category; pick the one nearest in complexity).
3. Build a **structured spec** that you'll hand to `doc-writer`. The spec is plain English / structured Markdown, not JSON. It MUST contain:
   - `name`, `category`, `display_name` (Title-cased), `since_version` (current `package.json` `version`)
   - The full `defaults: { ... }` object verbatim
   - For each defaults key, the widget type derived from the form template (TypedInput / select / checkbox / number / text / hidden)
   - The msg paths the JS handler reads (typed-input resolved) and writes
   - One-sentence summary of the C++ operation if present
   - Path to the sibling `.md` you chose as the tone anchor

If `--force` was not passed and the `.md` already exists at `docs/nodes/<cat>/<name>.md`, skip generation and only run Phase 3 (GIF) + Phase 4 (review). Otherwise continue to Phase 2.

## Phase 2 — Generate `.md` and HTML help block

Spawn `doc-writer` (foreground). Pass it the structured spec, plus the literal paths to the templates and prompts:

> You are producing documentation for `<NAME>` in `<CATEGORY>`. Use the spec below.
>
> Templates: `${CLAUDE_SKILL_DIR}/templates/node-doc.md.tmpl` and `${CLAUDE_SKILL_DIR}/templates/help-block.html.tmpl`.
>
> First, follow `${CLAUDE_SKILL_DIR}/prompts/synthesize-md.md` to produce `docs/nodes/<CATEGORY>/<NAME>.md`.
>
> Then, follow `${CLAUDE_SKILL_DIR}/prompts/synthesize-help.md` to rewrite the inline `<script data-help-name="rp-<NAME>">` block inside `node-red-contrib-image-tools/nodes/<CATEGORY>/<NAME>.html`.
>
> Spec:
>
> ```
> [structured spec here]
> ```
>
> Return the two paths you wrote/edited and any caveats.

If you're invoking `doc-writer` for a retry, append a `Fixes from previous review:` block listing the items the reviewer flagged.

## Phase 3 — Record the demo GIF

Spawn `gif-recorder` (foreground) with:

> Record a demo GIF for the `<NAME>` node in the `<CATEGORY>` category. Editor URL: `<EDITOR_URL>` (default `http://127.0.0.1:1880/`). Fixture image: `<FIXTURE_PATH>` (the validator generated one if needed; otherwise look in `assets/test-fixtures/`). Output: `assets/nodes/<CATEGORY>/<NAME>-demo.gif`. Specs: 800px wide, 10 fps, ≤6 s, looped, ≤400 KB.
>
> Build the smallest demo flow that visibly exercises this node, capture the deploy → inject → result loop, and clean up. Return your JSON summary.

If the recorder returns `ok: false`, do NOT abandon the run. Move to Phase 4 with whatever the recorder produced (it may have left a partial GIF) and let the reviewer flag the GIF problem; the retry loop handles it.

## Phase 4 — Review

Spawn `doc-reviewer` (foreground) with:

> Review the documentation for the `<NAME>` node in `<CATEGORY>`.
>
> Artefacts:
> - Markdown: `docs/nodes/<CATEGORY>/<NAME>.md`
> - HTML (help block): `node-red-contrib-image-tools/nodes/<CATEGORY>/<NAME>.html`
> - GIF: `assets/nodes/<CATEGORY>/<NAME>-demo.gif`
>
> Run the hard and soft checks from your system prompt. Return the `{ ok, fixes, notes }` JSON object.

**Decision tree:**
- `ok: true` → proceed to Phase 5.
- `ok: false` and retry count < 2 → loop back to Phase 2 with the reviewer's `fixes` (and Phase 3 again only if the GIF is among the issues).
- `ok: false` and retry count = 2 → stop. Report the remaining `fixes` to the user, leave the artefacts in place, exit with a clear message.

## Phase 5 — README and summary

1. Update the README node table at `README.md` (root). Add or update the row for this node in the right category section. Use a short factual purpose blurb derived from the new `.md`'s Overview.
2. Print a final summary:
   - Files written: `.md` path, `.html` (help block updated), `.gif` path.
   - GIF size in KB.
   - Total elapsed time (rough).
   - `git status --porcelain` of the changed paths so the user can review.

## Hard rules

1. **Phase 0 must pass before any other phase runs.** No exceptions.
2. **All artefacts are in English.** Every agent in this pipeline knows this; you don't need to remind them, but if you ever see Spanish slipping in, that's a `fixes` item for the reviewer.
3. **Subagents do not chain.** You invoke them sequentially from this skill body. Doc-writer never calls gif-recorder, etc.
4. **Max 2 retries** of Phase 2. After that, escalate to the user.
5. **Never modify source code.** Only `docs/`, `assets/`, the inline `<script data-help-name>` block in HTML, and `README.md`.
6. **Always clean up.** If a phase fails, the gif-recorder's cleanup of the demo flow is your safety net; verify it ran by calling `mcp__node-red__list-tabs` after Phase 3 and confirming the demo tab is gone.

## Argument parsing

- `<node-name>`: required. Validate by checking `rp-<name>` exists in `package.json` `node-red.nodes`.
- `--force`: optional. Re-generate even if `.md` already exists. Without `--force`, an existing `.md` skips Phase 2.

## Failure messages

- Phase 0 failed → "Documentation pipeline blocked: <validator note>. Fix and re-run /document-node."
- Phase 4 exhausted retries → "Documentation generated but reviewer flagged unresolved issues after 2 retries: <fixes list>. Artefacts left in place; please inspect docs/nodes/<cat>/<name>.md."
- GIF could not be made small enough → that's a Phase 4 fix; reviewer will retry Phase 3 specifically.
