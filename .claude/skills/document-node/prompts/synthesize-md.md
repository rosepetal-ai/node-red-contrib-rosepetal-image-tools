# Synthesize the long-form `.md` for a node

You are inside `doc-writer`. The orchestrator handed you a structured spec of one node and the path to `templates/node-doc.md.tmpl`. Produce the `.md` file at `docs/nodes/<category>/<name>.md`.

## Inputs you have

- `spec.name` — bare node name without `rp-` (e.g. `folder-in`).
- `spec.category` — one of `io`, `transform`, `mix`, `blend`, `specialized`.
- `spec.display_name` — Title-cased name for the H1 (e.g. "Folder-In").
- `spec.since_version` — the current `package.json` `version` field.
- `spec.defaults` — the `defaults: { ... }` object from the node's `*.html`, including TypedInput companion keys.
- `spec.template_form_widgets` — for each `defaults` key, the widget type derived from `<script type="text/html" data-template-name>` (TypedInput/select/checkbox/text/etc.).
- `spec.js_io` — what `msg` paths the JS handler reads (typed-input resolved) and writes.
- `spec.cpp_op` — the OpenCV operation in `rosepetal-image-engine/src/<name>.cpp` if applicable, with a one-sentence summary of its threading model and complexity.
- `spec.sibling_md_path` — path to the closest sibling `.md` in the same category, to mirror tone and depth.
- `spec.fixes` — optional. If the orchestrator is invoking you for a retry, this is the reviewer's list of corrections from the previous pass; address each before doing anything else.

## What to produce

A complete `.md` file that follows `node-doc.md.tmpl` exactly. Replace every `{{placeholder}}`. Specifically:

| Placeholder | What goes in |
|---|---|
| `{{display_name}}` | Title-cased name. |
| `{{name}}` | `spec.name`. |
| `{{category_label}}` | One of: `I/O`, `Transform`, `Mix`, `Blend`, `Specialized`. |
| `{{since_version}}` | `spec.since_version`. |
| `{{overview_paragraph}}` | 1–3 sentences. State the operation and what makes this node distinct from neighbours. No marketing words. No "high-performance" / "lightning-fast" / similar. |
| `{{use_cases_bullets}}` | 3–5 bullets, real-world, concrete. Mirror the tone of the sibling `.md`. Not invented features. |
| `{{category}}` | `spec.category` (lowercased). |
| `{{inputs_section}}` | Bulleted list. For each msg path the node reads, one bullet: `- \`msg.<path>\` *(TypedInput)*: <one-line description, mention single-or-array behaviour if applicable>`. |
| `{{outputs_section}}` | Bulleted list of msg paths the node writes. |
| `{{performance_key}}` | The output of `NodeUtils.getPerformanceKey(node)` — typically the `name` lowercased with non-alphanumerics replaced by `_`. If unsure, use `spec.name`. |
| `{{configuration_rows}}` | One Markdown table row per `spec.defaults` key, in declaration order. Aggregate `<x>PathType` companions into the row of `<x>Path`. Columns: Field (human-readable label, e.g. "Input from" not `inputPath`); Type (TypedInput, enum, number, boolean, string, color, hex); Default (the literal default value, or "—" for empty strings); Description (short, factual, no fluff). |
| `{{examples_section}}` | 2–4 mini ASCII flows. Each followed by a one-line caption. Use realistic msg paths from `spec.js_io`. Don't invent. Format: a fenced code block with `[node-a] → [<this-node>] → [node-b]`. |
| `{{troubleshooting_section}}` | At most 5 entries. Format: `- **<symptom>** — Cause: …  Solution: …`. Cover the genuine failure modes you can deduce from `defaults` validation in the JS handler (missing input, invalid dimensions, format mismatches). |
| `{{see_also_links}}` | 2–4 links to neighbouring nodes' `.md` from the same category, by relative path. |

## Hard rules

1. **English only.** Even if the conversation is in Spanish, the file is in English.
2. **No invented parameters.** Every Configuration row maps to an actual key in `spec.defaults`.
3. **No omitted parameters.** Every key in `spec.defaults` ends up in the Configuration table (companions can be aggregated; `name` is the only free pass).
4. **GIF link is mandatory** at the position the template specifies. Path: `../../../assets/nodes/<category>/<name>-demo.gif`.
5. **No cross-cutting concept duplication.** Don't restate the image format, typed-input mechanics, or error contract — link to `docs/concepts/` (even if those files don't exist yet; the link is a forward reference).
6. **Mirror tone of `spec.sibling_md_path`.** If the sibling is concise (e.g. `draw.md`), be concise. If the sibling is exhaustive (e.g. `image-align.md`), match that depth.

After writing the file, return the path. Do not produce HTML in this prompt — that's `synthesize-help.md`.
