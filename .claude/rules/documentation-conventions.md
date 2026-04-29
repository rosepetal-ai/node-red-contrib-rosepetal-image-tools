---
paths:
  - "docs/nodes/**/*.md"
  - "node-red-contrib-image-tools/nodes/**/*.html"
  - "assets/nodes/**"
description: |
  Canonical structure, GIF specs, and English-only rule for node documentation.
  Auto-loaded whenever Claude touches a node doc, a node HTML, or a node asset.
---

# Documentation conventions

These rules apply to anything under `docs/nodes/`, the inline `<script type="text/x-red" data-help-name="rp-<name>">` block in `node-red-contrib-image-tools/nodes/**/*.html`, and the `assets/nodes/<category>/` GIFs.

## Hard rules

1. **English only.** Every word of generated documentation, every comment, every example, every status string is English. The conversation language is irrelevant.
2. **Every node has a GIF.** The doc must reference `assets/nodes/<category>/<name>-demo.gif` from a Markdown image link, placed immediately under the Overview section. No GIF, no doc.
3. **No invented features.** Configuration, Inputs, Outputs, and Examples may only describe parameters and behaviour that are actually present in the node's `.html` `defaults: {}` block, the corresponding `.js` handler, and the C++ source if applicable.
4. **Round-trip parameters.** Every row in the `Configuration` table of the `.md` must correspond 1:1 to a key in the node's HTML `defaults: { ... }` block, and the inline help block must list the same parameters with the same types and defaults.
5. **No duplicated cross-cutting concepts.** The image format `{ data, width, height, channels, colorSpace, dtype }`, the typed-input mechanism (`msg`/`flow`/`global`/literal), and the error-passthrough contract (`msg.error`) are documented once in `docs/concepts/` (or referenced inline). Don't restate them in each node doc — link to them.

## Canonical 8-section template (Markdown)

Every node's `.md` follows this structure exactly:

```markdown
# <Display Name> Node

> **Type**: `rp-<name>` · **Category**: <I/O | Transform | Mix | Blend | Specialized> · **Since**: v<X.Y.Z>

## Overview
1–3 sentences: what the node does, what makes it distinct from neighbours.

**Use cases**
- bullet
- bullet

![<Display Name> Demo](../../../assets/nodes/<cat>/<name>-demo.gif)

## Inputs
- `msg.<path>`: short type description, single image vs array, accepted shapes.
- Cross-cutting concepts → link to `docs/concepts/image-format.md` etc.

## Outputs
- `msg.<path>`: shape and forms.
- `msg.performance.rpimage.<key>`: timing breakdown.
- `msg.error` (on failure): standard error contract.

## Configuration

| Field | Type | Default | Description |
|---|---|---|---|
| Input from | TypedInput (msg/flow/global) | `msg.payload` | … |
| Output to  | TypedInput (msg/flow/global) | `msg.payload` | … |
| Output Format | enum | `raw` | `raw` / `jpg` / `png` / `webp` |
| <field> | <type> | <default> | <one-line description> |

## Examples

```
[image-in] → [<node>: param=X] → [image-out]
```

Short narrative under each block.

## Troubleshooting

- **<short symptom>** — Cause: … · Solution: …
- (≤5 entries; move long FAQs out of this doc)

## See Also
- [related-node](../<other-cat>/<other-node>.md)
```

Optional sections only when the node is genuinely complex: `Performance Notes`, `Advanced Usage`. Don't pad simple nodes.

## GIF specifications

- **Path**: `assets/nodes/<category>/<name>-demo.gif`. The category folder mirrors `nodes/<category>/`.
- **Filename**: `<name>-demo.gif` exactly. The same `<name>` appears in `package.json` `node-red.nodes` (without the `rp-` prefix).
- **Reference from `.md`**: `![<Display Name> Demo](../../../assets/nodes/<category>/<name>-demo.gif)`.
- **Width**: 800 px.
- **Frame rate**: 10 fps.
- **Duration**: ≤6 s.
- **Loop**: infinite.
- **Size**: ≤400 KB. If the first ffmpeg pass exceeds this, generate a palette (`palettegen` + `paletteuse`) and re-encode; if still oversized, drop fps to 8 and try again before failing.
- **Content**: should show the flow being deployed (or the relevant input being injected) followed by the resulting output in the debug sidebar.

## Inline HTML help block

Inside each node's `.html`, immediately before `</body>`, there is exactly one block of the form:

```html
<script type="text/x-red" data-help-name="rp-<name>">
  <p>One-sentence summary.</p>

  <h3>Details</h3>
  <p>2–4 sentences expanding on the summary.</p>

  <h3>Properties</h3>
  <dl class="message-properties">
    <dt>Input from <span class="property-type">string</span></dt>
    <dd>…</dd>
    <!-- one <dt>/<dd> pair per defaults: {} key, in the same order -->
  </dl>

  <h3>Inputs</h3>
  <dl class="message-properties">
    <dt>payload <span class="property-type">object | array</span></dt>
    <dd>…</dd>
  </dl>

  <h3>Outputs</h3>
  <dl class="message-properties">
    <dt>payload <span class="property-type">object | array | Buffer</span></dt>
    <dd>…</dd>
  </dl>

  <h3>Examples</h3>
  <ul>
    <li><strong>Use case:</strong> 1-line scenario</li>
  </ul>

  <h3>Performance</h3>
  <p>One sentence on the C++/OpenCV backend and async behaviour.</p>
</script>
```

The Properties list and the `.md` Configuration table must enumerate the same fields in the same order with consistent types and defaults.

## When in doubt

- Lean on the **closest sibling `.md` in the same category** as a tone anchor (e.g. for a new `transform/` node, mirror `docs/nodes/transform/resize.md`).
- Keep simple nodes simple. Complex examples and Best Practices belong in the most complex nodes only (`image-align.md`, `advanced-mosaic.md`).
- Do not modify any source code (`*.js`, `*.cpp`, `lib/`, `src/`) while documenting. Only the inline `<script data-help-name>` block inside `*.html` may be edited.
