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
      /* paths */
      const inPath  = cfg.inputPath  || 'payload';
      const outPath = cfg.outputPath || 'payload';

      /* image / array - capture original for error passthrough */
      const originalPayload = RED.util.getMessageProperty(msg, inPath);

      try {
        const t0 = performance.now();
        node.status({});

        // Validate input images with error passthrough
        if (Array.isArray(originalPayload)) {
          if (!NodeUtils.validateListImage(originalPayload, node)) {
            return NodeUtils.handleValidationErrorWithPassthrough(
              node, 'Invalid image list structure', msg, send, done,
              { originalPayload, outputPath: outPath, outputType: 'preserve' }
            );
          }
        } else {
          if (!NodeUtils.validateSingleImage(originalPayload, node)) {
            return NodeUtils.handleValidationErrorWithPassthrough(
              node, 'Invalid image structure', msg, send, done,
              { originalPayload, outputPath: outPath, outputType: 'preserve' }
            );
          }
        }
        
        const imgs  = Array.isArray(originalPayload) ? originalPayload : [originalPayload];

        /* static options from editor */
        const outputFormat = cfg.outputFormat || 'raw';
        const outputQuality = parseInt(cfg.outputQuality) || 90;
        const pngOptimize = cfg.pngOptimize || false;
        const padHex   = cfg.padColor || '#000000';

        /* numeric margins can come from msg / flow / global */
        const tVal = Number(NodeUtils.resolveDimension(node, cfg.topType,    cfg.top,    msg));
        const bVal = Number(NodeUtils.resolveDimension(node, cfg.bottomType, cfg.bottom, msg));
        const lVal = Number(NodeUtils.resolveDimension(node, cfg.leftType,   cfg.left,   msg));
        const rVal = Number(NodeUtils.resolveDimension(node, cfg.rightType,  cfg.right,  msg));

        /* one C++ call per image (fast, runs in parallel) */
        const tasks = imgs.map(img =>
          CppProcessor.padding(img, tVal, bVal, lVal, rVal, padHex, outputFormat, outputQuality, pngOptimize)
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

        RED.util.setMessageProperty(msg, outPath, Array.isArray(originalPayload) ? outImgs : outImgs[0]);

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
            const debugImage = Array.isArray(originalPayload) ? outImgs[0] : outImgs[0];
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
              }, debugFormat + (Array.isArray(originalPayload) ? ' (first)' : ''));
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
          text:`OK: ${imgs.length} img in ${elapsedTime.toFixed(2)} ms `
              + `(conv ${(cMs+eMs).toFixed(2)} | task ${tMs.toFixed(2)} ms)`
        });

        }

        NodeUtils.recordPerformanceMetrics(node, msg, {
          convertMs: cMs,
          encodeMs: eMs,
          taskMs: tMs
        }, elapsedTime);

        send(msg); done && done();
      } catch (err) {
        NodeUtils.handleNodeErrorWithPassthrough(
          node, err, msg, send, done, 'padding processing',
          { originalPayload, outputPath: outPath, outputType: 'preserve' }
        );
      }
    });
  }

  RED.nodes.registerType('padding', PaddingNode);
};
