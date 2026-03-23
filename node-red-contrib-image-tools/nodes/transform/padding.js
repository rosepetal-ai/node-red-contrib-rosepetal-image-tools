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
      const inputPathType = cfg.inputPathType || 'msg';
      const outPath = cfg.outputPath || 'payload';
      const outputPathType = cfg.outputPathType || 'msg';

      /* image / array - capture original for error passthrough */
      const { value: originalPayload, error: inputErr } =
        NodeUtils.getInputValue(node, msg, inPath, inputPathType);
      if (inputErr) {
        const hint = inputPathType === 'msg'
          ? `Set inputPath to an existing msg property (e.g. "payload"), or ensure "${inPath}" exists before this node.`
          : `Set inputPath to an existing ${inputPathType} context key, or ensure "${inPath}" exists before this node.`;
        return NodeUtils.handleValidationErrorWithPassthrough(
          node,
          {
            message: `Invalid inputPath "${inPath}" (${inputPathType}): ${inputErr.message}`,
            hint,
            details: { inputPath: inPath, inputPathType, outputPath: outPath, outputPathType }
          },
          msg,
          send,
          done,
          { originalPayload: undefined, outputPath: null, outputPathType, outputType: 'preserve' }
        );
      }

      try {
        const t0 = performance.now();
        node.status({});

        // Validate input images with error passthrough
        if (Array.isArray(originalPayload)) {
          if (!NodeUtils.validateListImage(originalPayload, node)) {
            return NodeUtils.handleValidationErrorWithPassthrough(
              node, 'Invalid image list structure', msg, send, done,
              { originalPayload, outputPath: outPath, outputPathType, outputType: 'preserve' }
            );
          }
        } else {
          if (!NodeUtils.validateSingleImage(originalPayload, node)) {
            return NodeUtils.handleValidationErrorWithPassthrough(
              node, 'Invalid image structure', msg, send, done,
              { originalPayload, outputPath: outPath, outputPathType, outputType: 'preserve' }
            );
          }
        }
        
        const imgs  = Array.isArray(originalPayload) ? originalPayload : [originalPayload];

        /* static options from editor */
        const outputFormat = cfg.outputFormat || 'raw';
        const outputQuality = parseInt(cfg.outputQuality) || 90;
        const pngOptimize = cfg.pngOptimize || false;
        const useSharpWebp = outputFormat === 'webp' && NodeUtils.hasAdvancedWebpOptions(cfg);
        const cppFormat = useSharpWebp ? 'raw' : outputFormat;
        const padHex   = cfg.padColor || '#000000';

        /* numeric margins can come from msg / flow / global */
        const tVal = Number(NodeUtils.resolveDimension(node, cfg.topType,    cfg.top,    msg));
        const bVal = Number(NodeUtils.resolveDimension(node, cfg.bottomType, cfg.bottom, msg));
        const lVal = Number(NodeUtils.resolveDimension(node, cfg.leftType,   cfg.left,   msg));
        const rVal = Number(NodeUtils.resolveDimension(node, cfg.rightType,  cfg.right,  msg));

        /* one C++ call per image (fast, runs in parallel) */
        const tasks = imgs.map(img =>
          CppProcessor.padding(img, tVal, bVal, lVal, rVal, padHex, cppFormat, outputQuality, pngOptimize)
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

        if (useSharpWebp) {
          for (let i = 0; i < outImgs.length; i++) {
            outImgs[i] = await NodeUtils.encodeWebpAdvanced(outImgs[i], cfg);
          }
        }

        NodeUtils.setOutputValue(node, msg, outPath, outputPathType, Array.isArray(originalPayload) ? outImgs : outImgs[0]);

        // Debug image display
        const elapsedTime = performance.now() - t0;
        let debugFormat = null;
        const debugEnabled = cfg.debugEnabled === true || cfg.debugEnabled === 'true';
        if (debugEnabled) {
          try {
            // Resolve and validate debug width
            let debugWidth = NodeUtils.resolveDimension(
              node,
              cfg.debugWidthType || 'num',
              cfg.debugWidth,
              msg
            );
            debugWidth = Math.max(1, parseInt(debugWidth) || 200); // Ensure positive, default 200
            
            // For arrays, show the first image as representative
            const debugImage = outImgs[0];
            const debugResult = await NodeUtils.debugImageDisplay(
              debugImage, 
              outputFormat,
              outputQuality,
              node,
              debugEnabled,
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

        // --- Inference Transform ---
        if (cfg.inferenceEnabled === true || cfg.inferenceEnabled === 'true') {
          try {
            const InfTx = require('../../lib/inference-transform.js');
            const infPath = cfg.inferencePath || 'inference';
            const infPathType = cfg.inferencePathType || 'msg';
            const infOutPath = cfg.inferenceOutputPath || 'inference';
            const infOutPathType = cfg.inferenceOutputPathType || 'msg';
            const { value: inferences } = NodeUtils.getInputValue(node, msg, infPath, infPathType);

            if (inferences && Array.isArray(inferences) && inferences.length > 0) {
              const origImg = imgs[0];
              const txInfo = InfTx.makePaddingTransform({
                top: tVal, bottom: bVal, left: lVal, right: rVal,
                origW: origImg.width, origH: origImg.height
              });
              const transformed = await InfTx.applyTransform(inferences, txInfo, CppProcessor);
              NodeUtils.setOutputValue(node, msg, infOutPath, infOutPathType, transformed);
            }
          } catch (infErr) {
            node.warn(`Inference transform: ${infErr.message}`);
          }
        }

        send(msg); done && done();
      } catch (err) {
        NodeUtils.handleNodeErrorWithPassthrough(
          node, err, msg, send, done, 'padding processing',
          { originalPayload, outputPath: outPath, outputPathType, outputType: 'preserve' }
        );
      }
    });
  }

  RED.nodes.registerType('rp-padding', PaddingNode);
};
