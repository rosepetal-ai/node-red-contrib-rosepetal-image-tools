/**
 * Node-RED logic for *rosepetal-crop* (C++ backend)
 * Tiempos: convertMs · taskMs · encodeMs   →   OK … (conv X | task Y ms)
 */
const { performance } = require('perf_hooks');
const CppProcessor    = require('../../lib/cpp-bridge.js');

module.exports = function (RED) {
  const NodeUtils = require('../../lib/node-utils.js')(RED);

  function CropNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.on('input', async (msg, send, done) => {
      /* rutas I/O */
      const inputPath  = config.inputPath  || 'payload';
      const inputPathType = config.inputPathType || 'msg';
      const outputPath = config.outputPath || 'payload';
      const outputPathType = config.outputPathType || 'msg';

      /* Capture original payload for error passthrough */
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
        node.status({});

        /* flags */
        const normalized = !!config.coordNorm;
        const outputFormat = config.outputFormat || 'raw';
        const outputQuality = parseInt(config.outputQuality) || 90;
        const pngOptimize = config.pngOptimize || false;
        const useSharpWebp = outputFormat === 'webp' && NodeUtils.hasAdvancedWebpOptions(config);
        const cppFormat = useSharpWebp ? 'raw' : outputFormat;

        /* imagen o lista de imágenes */
        const imgs = Array.isArray(originalPayload) ? originalPayload : [originalPayload];

        // Validate input images
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

        const x = Number(NodeUtils.resolveDimension(node, config.cropXType, config.cropX, msg));
        const y = Number(NodeUtils.resolveDimension(node, config.cropYType, config.cropY, msg));
        const width = Number(NodeUtils.resolveDimension(node, config.widthType, config.width, msg));
        const height = Number(NodeUtils.resolveDimension(node, config.heightType, config.height, msg));

        /* lanzar recortes en paralelo */
        const jobs = imgs.map(img =>
          CppProcessor.crop(img, x, y, width, height, normalized, cppFormat, outputQuality, pngOptimize)
        );

        const results = await Promise.all(jobs);

        /* acumular métricas */
        const { totalConvertMs, totalTaskMs, totalEncodeMs, images } =
          results.reduce((acc, { image, timing }) => {
            acc.totalConvertMs += timing?.convertMs ?? 0;
            acc.totalTaskMs    += timing?.taskMs    ?? 0;
            acc.totalEncodeMs  += timing?.encodeMs  ?? 0;
            acc.images.push(image);
            return acc;
          }, { totalConvertMs: 0, totalTaskMs: 0, totalEncodeMs: 0, images: [] });

        if (useSharpWebp) {
          for (let i = 0; i < images.length; i++) {
            images[i] = await NodeUtils.encodeWebpAdvanced(images[i], config);
          }
        }

        /* salida */
        const out = Array.isArray(originalPayload) ? images : images[0];
        NodeUtils.setOutputValue(node, msg, outputPath, outputPathType, out);

        /* status con mismo formato que resize/rotate */
        const dur = performance.now() - t0;
        
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
              NodeUtils.setSuccessStatusWithDebug(node, imgs.length, dur, {
                convertMs: totalConvertMs,
                taskMs: totalTaskMs,
                encodeMs: totalEncodeMs
              }, debugFormat + (Array.isArray(originalPayload) ? ' (first)' : ''));
            }
          } catch (debugError) {
            node.warn(`Debug display error: ${debugError.message}`);
          }
        }
        
        // Set regular status if debug not enabled or failed
        if (!debugFormat) {
          node.status({
            fill  : 'green',
            shape : 'dot',
            text  : `OK: ${imgs.length} img in ${dur.toFixed(2)} ms `
                  + `(conv ${(totalConvertMs + totalEncodeMs).toFixed(2)} ms | `
                  + `task ${totalTaskMs.toFixed(2)} ms)`
          });
        }

        NodeUtils.recordPerformanceMetrics(node, msg, {
          convertMs: totalConvertMs,
          encodeMs: totalEncodeMs,
          taskMs: totalTaskMs
        }, dur);

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
              // Normalize crop coords to 0-1 if in pixel mode
              let cx0, cy0, cw, ch;
              if (normalized) {
                cx0 = x; cy0 = y; cw = width; ch = height;
              } else {
                cx0 = x / origImg.width;
                cy0 = y / origImg.height;
                cw = width / origImg.width;
                ch = height / origImg.height;
              }
              const txInfo = InfTx.makeCropTransform({ x0: cx0, y0: cy0, w: cw, h: ch });
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
          node, err, msg, send, done, 'crop processing',
          { originalPayload, outputPath, outputPathType, outputType: 'preserve' }
        );
      }
    });
  }

  RED.nodes.registerType('rp-crop', CropNode);
};
