/**
 * Node‑RED logic for *rosepetal‑padding* (C++ backend)
 * Shows timings like the rest of the Rosepetal nodes.
 */
const { performance } = require('perf_hooks');
const CppProcessor    = require('../../lib/cpp-bridge.js');

module.exports = function (RED) {
  const NodeUtils = require('../../lib/node-utils.js')(RED);

  function PaddingNode(cfg) {
    RED.nodes.createNode(this, cfg);
    const node = this;

    node.on('input', async (msg, send, done) => {
      try {
        const t0 = performance.now();
        node.status({});

        /* paths */
        const inPath  = cfg.inputPath  || 'payload';
        const outPath = cfg.outputPath || 'payload';

        /* image / array */
        const rawIn = RED.util.getMessageProperty(msg, inPath);
        
        // Validate input images
        if (Array.isArray(rawIn)) {
          if (!NodeUtils.validateListImage(rawIn, node)) {
            // Warning already sent, don't send message
            return;
          }
        } else {
          if (!NodeUtils.validateSingleImage(rawIn, node)) {
            // Warning already sent, don't send message
            return;
          }
        }
        
        const imgs  = Array.isArray(rawIn) ? rawIn : [rawIn];

        /* static options from editor */
        const outputFormat = cfg.outputFormat || 'raw';
        const outputQuality = cfg.outputQuality || 90;
        const padHex   = cfg.padColor || '#000000';

        /* numeric margins can come from msg / flow / global */
        const tVal = Number(NodeUtils.resolveDimension(node, cfg.topType,    cfg.top,    msg));
        const bVal = Number(NodeUtils.resolveDimension(node, cfg.bottomType, cfg.bottom, msg));
        const lVal = Number(NodeUtils.resolveDimension(node, cfg.leftType,   cfg.left,   msg));
        const rVal = Number(NodeUtils.resolveDimension(node, cfg.rightType,  cfg.right,  msg));

        /* one C++ call per image (fast, runs in parallel) */
        const tasks = imgs.map(img =>
          CppProcessor.padding(img, tVal, bVal, lVal, rVal, padHex, outputFormat, outputQuality)
        );
        const results = await Promise.all(tasks);

        /* collect timings */
        let cMs = 0, tMs = 0, eMs = 0;
        const outImgs = results.map(r => {
          cMs += r.timing.convertMs;
          tMs += r.timing.taskMs;
          eMs += r.timing.encodeMs;
          return r.image;
        });

        RED.util.setMessageProperty(msg, outPath, Array.isArray(rawIn) ? outImgs : outImgs[0]);

        // Debug image display
        const elapsedTime = performance.now() - t0;
        let debugFormat = null;
        if (cfg.debugEnabled) {
          try {
            // Resolve and validate debug width
            let debugWidth = NodeUtils.resolveDimension(
              node,
              cfg.debugWidthType,
              cfg.debugWidth,
              msg
            );
            debugWidth = Math.max(1, parseInt(debugWidth) || 200); // Ensure positive, default 200
            
            // For arrays, show the first image as representative
            const debugImage = Array.isArray(rawIn) ? outImgs[0] : outImgs[0];
            const debugResult = await NodeUtils.debugImageDisplay(
              debugImage, 
              outputFormat,
              outputQuality,
              node,
              true,
              debugWidth
            );
            
            if (debugResult) {
              debugFormat = debugResult.formatMessage;
              // Update node status with debug info
              NodeUtils.setSuccessStatusWithDebug(node, imgs.length, elapsedTime, {
                convertMs: cMs,
                taskMs: tMs,
                encodeMs: eMs
              }, debugFormat + (Array.isArray(rawIn) ? ' (first)' : ''));
            }
          } catch (debugError) {
            node.warn(`Debug display error: ${debugError.message}`);
          }
        }
        
        // Set regular status if debug not enabled or failed
        if (!debugFormat) {
          /* node status */
        node.status({
          fill:'green', shape:'dot',
          text:`OK: ${imgs.length} img in ${(performance.now()-t0).toFixed(2)} ms `
              + `(conv ${(cMs+eMs).toFixed(2)} | task ${tMs.toFixed(2)} ms)`
        });

        send(msg); done && done();
      } catch (err) {
        node.status({ fill: "red", shape: "ring", text: "Error" });
        node.warn(`Error during padding processing: ${err.message}`);
        // Don't send message on error
        if (done) { done(); }
      }
    });
  }

  RED.nodes.registerType('padding', PaddingNode);
};
