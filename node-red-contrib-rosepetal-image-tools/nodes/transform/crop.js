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
      try {
        const t0 = performance.now();
        node.status({});

        /* rutas I/O */
        const inPath  = config.inputPath  || 'payload';
        const outPath = config.outputPath || 'payload';

        /* flags */
        const normalized = !!config.coordNorm;
        const outputFormat = config.outputFormat || 'raw';
        const outputQuality = config.outputQuality || 90;

        /* imagen o lista de imágenes */
        const original = RED.util.getMessageProperty(msg, inPath);
        const imgs     = Array.isArray(original) ? original : [original];

        // Validate input images
        if (Array.isArray(original)) {
          if (!NodeUtils.validateListImage(original, node)) {
            // Warning already sent, don't send message
            return;
          }
        } else {
          if (!NodeUtils.validateSingleImage(original, node)) {
            // Warning already sent, don't send message
            return;
          }
        }

        /* lanzar recortes en paralelo */
        const jobs = imgs.map(img => {
          const x = Number(NodeUtils.resolveDimension(node, config.cropXType, config.cropX, msg));
          const y = Number(NodeUtils.resolveDimension(node, config.cropYType, config.cropY, msg));
          const width = Number(NodeUtils.resolveDimension(node, config.widthType, config.width, msg));
          const height = Number(NodeUtils.resolveDimension(node, config.heightType, config.height, msg));

          return CppProcessor.crop(img, x, y, width, height, normalized, outputFormat, outputQuality);
        });

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
        const out = Array.isArray(original) ? images : images[0];
        RED.util.setMessageProperty(msg, outPath, out);

        /* status con mismo formato que resize/rotate */
        const dur = performance.now() - t0;
        
        // Debug image display
        let debugFormat = null;
        if (config.debugEnabled) {
          try {
            // Resolve and validate debug width
            let debugWidth = NodeUtils.resolveDimension(
              node,
              config.debugWidthType,
              config.debugWidth,
              msg
            );
            debugWidth = Math.max(1, parseInt(debugWidth) || 200); // Ensure positive, default 200
            
            // For arrays, show the first image as representative
            const debugImage = Array.isArray(original) ? images[0] : images[0];
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
              NodeUtils.setSuccessStatusWithDebug(node, imgs.length, dur, {
                convertMs: totalConvertMs,
                taskMs: totalTaskMs,
                encodeMs: totalEncodeMs
              }, debugFormat + (Array.isArray(original) ? ' (first)' : ''));
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

        send(msg);
        done && done();
      } catch (err) {
        node.status({ fill: "red", shape: "ring", text: "Error" });
        node.warn(`Error during crop processing: ${err.message}`);
        // Don't send message on error
        if (done) { done(); }
      }
    });
  }

  RED.nodes.registerType('crop', CropNode);
};
