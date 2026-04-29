# Synthesize the inline `<script data-help-name="rp-...">` block

You are inside `doc-writer`. After producing the `.md`, your second job is to **rewrite the inline help block** inside `node-red-contrib-image-tools/nodes/<category>/<name>.html` so the editor's "info" pane stays in sync.

## What to do

1. Read `node-red-contrib-image-tools/nodes/<category>/<name>.html`.
2. Locate the existing `<script type="text/x-red" data-help-name="rp-<name>">…</script>` block. There is exactly one. If it doesn't exist, the block is appended just before the closing of the file.
3. Generate a new block by filling `templates/help-block.html.tmpl`.
4. Replace the existing block with the new one using `Edit`. Don't touch anything else in the file.

## Mapping from the spec

| Placeholder | What goes in |
|---|---|
| `{{name}}` | `spec.name`. |
| `{{summary_one_sentence}}` | The same one-sentence summary as the `.md`'s Overview's first sentence. |
| `{{details_paragraph}}` | 2–4 sentences. Slightly more technical than the summary. Mention the C++/OpenCV backend if applicable. |
| `{{properties_dl_entries}}` | One `<dt>/<dd>` pair per Configuration row in the same order as the `.md` table. Format: `<dt>Label <span class="property-type">type</span></dt><dd>description.</dd>`. |
| `{{input_type}}` | One of: `object`, `array`, `object \| array`, `Buffer`, `object \| Buffer`. Match what the JS handler accepts. |
| `{{input_description}}` | One sentence. Mention single image vs array. Cross-reference: `Standard image structure: { data, width, height, channels, colorSpace, dtype }.` |
| `{{output_type}}` | Same enum, what the node emits. Encoded formats are `Buffer`. |
| `{{output_description}}` | One sentence. Mention how the format is determined ("depends on Output Format setting"). |
| `{{examples_li_entries}}` | 2–4 `<li><strong>Use case:</strong> 1-line scenario</li>` items. Mirror the `.md`'s Examples but as compact list items. |
| `{{performance_paragraph}}` | One sentence on the C++ backend, async behaviour, and array-parallelism. |

## Hard rules

1. **English only.**
2. **Properties match `.md` Configuration table exactly** — same fields, same order, same types, same defaults.
3. **No marketing language.** "Uses OpenCV's optimized resize" is fine; "lightning-fast professional-grade" is not.
4. **Don't touch the rest of the HTML.** No edits to the registration script, no edits to the form template. Only the `data-help-name` block.
5. If the file has no closing `</body>` (it's a Node-RED partial, which is normal), simply locate the `data-help-name` block by regex and use `Edit` with the precise old/new strings.
