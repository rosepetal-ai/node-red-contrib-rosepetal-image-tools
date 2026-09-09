---
paths:
  - "node-red-contrib-image-tools/nodes/**/*.js"
  - "node-red-contrib-image-tools/nodes/**/*.html"
description: |
  Canonical implementation pattern for Node-RED nodes in this toolkit.
  Auto-loaded whenever Claude touches a node JS or HTML file. Documentation
  agents read this to understand what parameters/contracts to surface.
---

# Node implementation pattern

Every node in this toolkit follows the same shape. When documenting a node, extract from these locations; when adding a node, mirror them.

## File layout

```
node-red-contrib-image-tools/nodes/<category>/<name>.js     # Node-RED handler
node-red-contrib-image-tools/nodes/<category>/<name>.html   # editor UI + help block
rosepetal-image-engine/src/<name>.cpp                       # OpenCV implementation (if native)
```

Categories: `io`, `transform`, `mix`, `blend`, `specialized`.

## JS handler structure (canonical: `nodes/transform/resize.js`)

```js
const { performance } = require('perf_hooks');
const CppProcessor = require('../../lib/cpp-bridge.js');

module.exports = function (RED) {
  const NodeUtils = require('../../lib/node-utils.js')(RED);

  function <Name>Node(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.on('input', async (msg, send, done) => {
      const inputPath  = config.inputPath  || 'payload';
      const inputPathType = config.inputPathType || 'msg';
      const outputPath = config.outputPath || 'payload';
      const outputPathType = config.outputPathType || 'msg';

      // 1. Resolve input via NodeUtils.getInputValue
      // 2. Validate single image or array
      // 3. Resolve dimensions / typed inputs via NodeUtils.resolveDimension / resolveArrayPosition
      // 4. fan-out: const promises = inputList.map(img => CppProcessor.<op>(img, ...))
      // 5. const results = await Promise.all(promises)
      // 6. Aggregate timings (convertMs/taskMs/encodeMs)
      // 7. NodeUtils.setSuccessStatus + recordPerformanceMetrics
      // 8. NodeUtils.setOutputValue
      // 9. Optional inferenceEnabled → InfTx.applyTransform
      // 10. send(msg); done();
      // catch → NodeUtils.handleNodeErrorWithPassthrough (preserves originalPayload)
    });
  }

  RED.nodes.registerType('rp-<name>', <Name>Node);
};
```

## HTML structure

```html
<script type="text/javascript">
  RED.nodes.registerType('rp-<name>', {
    category: 'RP Image',
    color: '#DDA0DD',
    defaults: {
      name:               { value: "" },
      inputPath:          { value: "payload" },
      inputPathType:      { value: "msg" },
      outputPath:         { value: "payload" },
      outputPathType:     { value: "msg" },
      outputFormat:       { value: "raw" },
      outputQuality:      { value: 90 },
      pngOptimize:        { value: false },
      // … node-specific params
      debugEnabled:       { value: false },
      debugWidth:         { value: 200 },
      debugWidthType:     { value: "num" }
    },
    inputs: 1, outputs: 1,
    icon: "font-awesome/fa-...",
    label: function () { return this.name || 'rp-<name>'; },
    oneditprepare: function () { /* TypedInput init, conditional row visibility */ }
  });
</script>

<script type="text/html" data-template-name="rp-<name>">
  <!-- form rows with TypedInput widgets -->
</script>

<script type="text/x-red" data-help-name="rp-<name>">
  <!-- canonical inline help block — see documentation-conventions.md -->
</script>
```

## What to extract for documentation

When the doc-writer agent reads a node, it must extract:

| From | Field | Used for |
|---|---|---|
| `*.html` `defaults: { … }` | every key + initial value | the Configuration table rows + Properties `<dl>` |
| `*.html` `<script type="text/html" data-template-name>` | `<input id="node-input-X">` widgets | type information for each field (TypedInput vs select vs checkbox) |
| `*.js` `node.on('input', …)` body | which `config.<key>` are read; which `msg.<path>` are read/written | Inputs/Outputs section |
| `package.json` `node-red.nodes` | the registered type id | confirm the `rp-<name>` mapping |
| sibling `.md` in the same category | tone, depth | style anchor |
| `rosepetal-image-engine/src/<name>.cpp` (if exists) | OpenCV operation, threading model | the optional Performance Notes section |

The doc-writer must never add a doc row whose key is not in `defaults: {}`, and must never omit a `defaults` key (even if it seems unimportant; fields like `name` and the typed-input pair `<x>PathType` are also part of the contract — but `name` and the `*PathType` companions can be aggregated under "Input from"/"Output to" rather than listed separately).

## Common helpers in `lib/node-utils.js`

These are the names doc-writer is allowed to reference in Examples:

- `getInputValue` / `setOutputValue` — TypedInput-aware msg path read/write
- `validateImageStructure`, `validateSingleImage`, `validateListImage` — input shape validation
- `resolveDimension`, `resolveArrayPosition` — typed-numeric resolution
- `setSuccessStatus`, `setSuccessStatusWithDebug` — node status display
- `handleNodeErrorWithPassthrough`, `handleValidationErrorWithPassthrough` — error path
- `recordPerformanceMetrics` — sets `msg.performance.rpimage.<key>`
- `debugImageDisplay` — emits the editor preview via `RED.comms.publish('debug-image', …)`
- `rawToJpeg`, `encodeWebpAdvanced` — Sharp-based encoders (BGR/BGRA inputs are converted natively via `toSharpRaw`)
