/**
 * Node-RED logic for *rosepetal-rotate* — always padding, timing formatted.
 */
const { performance } = require('perf_hooks');
const CppProcessor    = require('../../lib/cpp-bridge.js');

module.exports = function (RED) {
  const NodeUtils = require('../../lib/node-utils.js')(RED);

  function RotateNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.on('input', async (msg, send, done) => {
      const inputPath   = config.inputPath  || 'payload';
      const inputPathType = config.inputPathType || 'msg';
      const outputPath  = config.outputPath || 'payload';
      const outputPathType = config.outputPathType || 'msg';
      const { value: originalPayload, error: inputErr } =
        NodeUtils.getInputValue(node, msg, inputPath, inputPathType);
      if (inputErr) {
        const hint = inputPathType === 'msg'
          ? `Set inputPath to an existing msg property (e.g. "payload"), or ensure "${inputPath}" exists before this node.`
          : `Set inputPath to an existing ${inputPathType} context key, or ensure "${inputPath}" exists before this node.`;
        return NodeUtils.handleValidationErrorWithPassthrough(
          node,
          {
            message: `Invalid inputPath "${inputPath}" (${inputPathType}): ${inputErr.message}`,
            hint,
            details: { inputPath, inputPathType, outputPath, outputPathType }
          },
          msg,
          send,
          done,
          { originalPayload: undefined, outputPath: null, outputPathType, outputType: 'preserve' }
        );
      }

      try {
        const t0 = performance.now();
        node.status({});                                   // clear
        const outputFormat = config.outputFormat || 'raw';
        const outputQuality = parseInt(config.outputQuality) || 90;
        const pngOptimize = config.pngOptimize || false;
        const useSharpWebp = outputFormat === 'webp' && NodeUtils.hasAdvancedWebpOptions(config);
        const cppFormat = useSharpWebp ? 'raw' : outputFormat;
        const padColorHex = config.padColor    || '#000000';

        // Validate input images with error passthrough
        if (Array.isArray(originalPayload)) {
          if (!NodeUtils.validateListImage(originalPayload, node)) {
            return NodeUtils.handleValidationErrorWithPassthrough(
              node, 'Invalid image list structure', msg, send, done,
              { originalPayload, outputPath, outputPathType, outputType: 'preserve' }
            );
          }
        } else {
          if (!NodeUtils.validateSingleImage(originalPayload, node)) {
            return NodeUtils.handleValidationErrorWithPassthrough(
              node, 'Invalid image structure', msg, send, done,
              { originalPayload, outputPath, outputPathType, outputType: 'preserve' }
            );
          }
        }
        
        const imgs     = Array.isArray(originalPayload) ? originalPayload : [originalPayload];

        let angle = NodeUtils.resolveDimension(
          node, config.angleType, config.angleValue, msg);
        angle = angle === null || angle === '' ? 0 : Number(angle);

        /* ——— lanzar rotaciones en paralelo ——— */
        const promises = imgs.map(img =>
          CppProcessor.rotate(img, angle, padColorHex, cppFormat, outputQuality, pngOptimize)
        );

        const results = await Promise.all(promises);

        /* ——— acumular métricas ——— */
        const { totalConvertMs, totalTaskMs, encodeMs, images } =
          results.reduce((acc, { image, timing }) => {
            acc.totalConvertMs += timing?.convertMs ?? 0;
            acc.totalTaskMs    += timing?.taskMs    ?? 0;
            acc.encodeMs       += timing?.encodeMs  ?? 0;
            acc.images.push(image);
            return acc;
          }, { totalConvertMs: 0, totalTaskMs: 0, encodeMs: 0, images: [] });

        if (useSharpWebp) {
          // Encode all images concurrently (Sharp runs on the libuv thread pool)
          const webps = await Promise.all(images.map((img) => NodeUtils.encodeWebpAdvanced(img, config)));
          webps.forEach((webp, i) => { images[i] = webp; });
        }

        const out   = Array.isArray(originalPayload) ? images : images[0];
        const durMs = performance.now() - t0;

        NodeUtils.setOutputValue(node, msg, outputPath, outputPathType, out);

        // Debug image display
        let debugFormat = null;
        const debugEnabled = config.debugEnabled === true || config.debugEnabled === 'true';
        if (debugEnabled) {
          try {
            // Resolve and validate debug width
            let debugWidth = NodeUtils.resolveDimension(
              node,
              config.debugWidthType || 'num',
              config.debugWidth,
              msg
            );
            debugWidth = Math.max(1, parseInt(debugWidth) || 200); // Ensure positive, default 200
            
            // For arrays, show the first image as representative
            const debugImage = images[0];
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
              NodeUtils.setSuccessStatusWithDebug(node, imgs.length, durMs, {
                convertMs: totalConvertMs,
                taskMs: totalTaskMs,
                encodeMs: encodeMs
              }, debugFormat + (Array.isArray(originalPayload) ? ' (first)' : ''));
            }
          } catch (debugError) {
            node.warn(`Debug display error: ${debugError.message}`);
          }
        }
        
        // Set regular status if debug not enabled or failed
        if (!debugFormat) {
          /* ——— mismo formato que en resize ——— */
          node.status({
            fill  : 'green',
            shape : 'dot',
            text  : `OK: ${imgs.length} img in ${durMs.toFixed(2)} ms `
                  + `(conv ${(totalConvertMs + encodeMs).toFixed(2)} ms `
                  + `| task ${totalTaskMs.toFixed(2)} ms)`
          });
        }

        NodeUtils.recordPerformanceMetrics(node, msg, {
          convertMs: totalConvertMs,
          encodeMs: encodeMs,
          taskMs: totalTaskMs
        }, durMs);

        // --- Inference Transform ---
        if (config.inferenceEnabled === true || config.inferenceEnabled === 'true') {
          try {
            const InfTx = require('../../lib/inference-transform.js');
            const infPath = config.inferencePath || 'inference';
            const infPathType = config.inferencePathType || 'msg';
            const infOutPath = config.inferenceOutputPath || 'inference';
            const infOutPathType = config.inferenceOutputPathType || 'msg';
            const { value: inferences } = NodeUtils.getInputValue(node, msg, infPath, infPathType);

            if (inferences && Array.isArray(inferences) && inferences.length > 0) {
              const origImg = imgs[0];
              const txInfo = InfTx.makeRotateTransform({
                angleDeg: angle,
                origW: origImg.width,
                origH: origImg.height
              });
              const transformed = await InfTx.applyTransform(inferences, txInfo, CppProcessor);
              NodeUtils.setOutputValue(node, msg, infOutPath, infOutPathType, transformed);
            }
          } catch (infErr) {
            node.warn(`Inference transform: ${infErr.message}`);
          }
        }

        send(msg);
        done && done();
      } catch (err) {
        NodeUtils.handleNodeErrorWithPassthrough(
          node, err, msg, send, done, 'rotate processing',
          { originalPayload, outputPath, outputPathType, outputType: 'preserve' }
        );
      }
    });
  }

  RED.nodes.registerType('rp-rotate', RotateNode);
};
