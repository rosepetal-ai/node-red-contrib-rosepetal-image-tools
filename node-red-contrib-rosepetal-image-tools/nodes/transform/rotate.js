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
      try {
        const t0 = performance.now();
        node.status({});                                   // clear

        const inputPath   = config.inputPath  || 'payload';
        const outputPath  = config.outputPath || 'payload';
        const outputFormat = config.outputFormat || 'raw';
        const outputQuality = parseInt(config.outputQuality) || 90;
        const pngOptimize = config.pngOptimize || false;
        const padColorHex = config.padColor    || '#000000';

        const original = RED.util.getMessageProperty(msg, inputPath);
        
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
        
        const imgs     = Array.isArray(original) ? original : [original];

        /* ——— lanzar rotaciones en paralelo ——— */
        const promises = imgs.map(img => {
          let angle = NodeUtils.resolveDimension(
            node, config.angleType, config.angleValue, msg);
          angle = angle === null || angle === '' ? 0 : Number(angle);

          return CppProcessor.rotate(img, angle, padColorHex, outputFormat, outputQuality, pngOptimize);
        });

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

        const out   = Array.isArray(original) ? images : images[0];
        const durMs = performance.now() - t0;

        RED.util.setMessageProperty(msg, outputPath, out);

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
              NodeUtils.setSuccessStatusWithDebug(node, imgs.length, durMs, {
                convertMs: totalConvertMs,
                taskMs: totalTaskMs,
                encodeMs: encodeMs
              }, debugFormat + (Array.isArray(original) ? ' (first)' : ''));
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

        send(msg);
        done && done();
      } catch (err) {
        node.status({ fill: "red", shape: "ring", text: "Error" });
        node.warn(`Error during rotate processing: ${err.message}`);
        // Don't send message on error
        if (done) { done(); }
      }
    });
  }

  RED.nodes.registerType('rotate', RotateNode);
};
