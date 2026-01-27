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
      const outputPath = config.outputPath || 'payload';

      /* Capture original payload for error passthrough */
      const { value: originalPayload, error: inputErr } =
        NodeUtils.safeGetMessageProperty(msg, inputPath);
      if (inputErr) {
        return NodeUtils.handleValidationErrorWithPassthrough(
          node,
          {
            message: `Invalid inputPath "${inputPath}": ${inputErr.message}`,
            hint: `Set inputPath to an existing msg property (e.g. "payload"), or ensure "${inputPath}" exists before this node.`,
            details: { inputPath, outputPath }
          },
          msg,
          send,
          done,
          { originalPayload: undefined, outputPath: null, outputType: 'preserve' }
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

        /* imagen o lista de imágenes */
        const imgs = Array.isArray(originalPayload) ? originalPayload : [originalPayload];

        // Validate input images
        if (Array.isArray(originalPayload)) {
          if (!NodeUtils.validateListImage(originalPayload, node)) {
            return NodeUtils.handleValidationErrorWithPassthrough(
              node, 'Invalid image list structure', msg, send, done,
              { originalPayload, outputPath, outputType: 'preserve' }
            );
          }
        } else {
          if (!NodeUtils.validateSingleImage(originalPayload, node)) {
            return NodeUtils.handleValidationErrorWithPassthrough(
              node, 'Invalid image structure', msg, send, done,
              { originalPayload, outputPath, outputType: 'preserve' }
            );
          }
        }

        const x = Number(NodeUtils.resolveDimension(node, config.cropXType, config.cropX, msg));
        const y = Number(NodeUtils.resolveDimension(node, config.cropYType, config.cropY, msg));
        const width = Number(NodeUtils.resolveDimension(node, config.widthType, config.width, msg));
        const height = Number(NodeUtils.resolveDimension(node, config.heightType, config.height, msg));

        /* lanzar recortes en paralelo */
        const jobs = imgs.map(img =>
          CppProcessor.crop(img, x, y, width, height, normalized, outputFormat, outputQuality, pngOptimize)
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

        /* salida */
        const out = Array.isArray(originalPayload) ? images : images[0];
        RED.util.setMessageProperty(msg, outputPath, out);

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

        send(msg);
        done && done();
      } catch (err) {
        NodeUtils.handleNodeErrorWithPassthrough(
          node, err, msg, send, done, 'crop processing',
          { originalPayload, outputPath, outputType: 'preserve' }
        );
      }
    });
  }

  RED.nodes.registerType('crop', CropNode);
};
