/**
 * Node-RED logic for *rosepetal-advanced-mosaic* (Ultra-optimized C++ backend).
 * Creates composite images with per-image transformations (resize, rotate) and positioning.
 * Super fast with zero-copy operations and parallel processing.
 */
const { performance } = require('perf_hooks');
const CppProcessor = require('../../lib/cpp-bridge.js');

module.exports = function (RED) {
  const NodeUtils = require('../../lib/node-utils.js')(RED);

  function AdvancedMosaicNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.on('input', async (msg, send, done) => {
      try {
        const t0 = performance.now();
        node.status({});

        /* I/O paths */
        const inputPath = config.inputPath || 'payload';
        const outputPath = config.outputPath || 'payload';
        const outputFormat = config.outputFormat || 'raw';
        const outputQuality = parseInt(config.outputQuality) || 90;
        const pngOptimize = config.pngOptimize || false;

        /* Canvas configuration */
        const canvasWidth = Number(NodeUtils.resolveDimension(node, config.canvasWidthType, config.canvasWidth, msg));
        const canvasHeight = Number(NodeUtils.resolveDimension(node, config.canvasHeightType, config.canvasHeight, msg));
        const backgroundColor = config.backgroundColor || '#000000';
        const normalized = !!config.coordNorm;

        /* Image configurations */
        const imageConfigs = config.imageConfigs || [];
        
        /* Input images array */
        const inputImages = RED.util.getMessageProperty(msg, inputPath);
        const imageArray = Array.isArray(inputImages) ? inputImages : [inputImages];

        // Validate input images - advanced mosaic expects array input
        if (!NodeUtils.validateListImage(imageArray, node)) {
          // Warning already sent, don't send message
          return;
        }

        /* Validate image configurations */
        const validImageConfigs = imageConfigs.filter(config => {
          const arrayIndex = parseInt(config.arrayIndex);
          return arrayIndex >= 0 && arrayIndex < imageArray.length;
        });

        // Note: Allow empty validImageConfigs - this will create canvas with just background color

        /* Validate canvas dimensions */
        if (canvasWidth <= 0 || canvasHeight <= 0) {
          throw new Error('Canvas dimensions must be positive numbers');
        }

        /* Single ultra-fast C++ call */
        const { image, timing = {} } = await CppProcessor.advancedMosaic(
          imageArray,
          canvasWidth,
          canvasHeight,
          backgroundColor,
          validImageConfigs,
          normalized,
          outputFormat,
          outputQuality,
          pngOptimize
        );

        /* Set output */
        RED.util.setMessageProperty(msg, outputPath, image);

        /* Performance status - same format as other nodes */
        const { convertMs = 0, taskMs = 0, encodeMs = 0 } = timing;
        const totalTime = performance.now() - t0;
        
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
            
            const debugResult = await NodeUtils.debugImageDisplay(
              image, 
              outputFormat,
              outputQuality,
              node,
              true,
              debugWidth
            );
            
            if (debugResult) {
              debugFormat = debugResult.formatMessage;
              // Update node status with debug info
              const configsText = validImageConfigs.length === 0 ? 'empty canvas' : `${validImageConfigs.length} img`;
              NodeUtils.setSuccessStatusWithDebug(node, 1, totalTime, {
                convertMs: convertMs,
                taskMs: taskMs,
                encodeMs: encodeMs
              }, `${debugFormat} (${configsText})`);
            }
          } catch (debugError) {
            node.warn(`Debug display error: ${debugError.message}`);
          }
        }
        
        // Set regular status if debug not enabled or failed
        if (!debugFormat) {
          const statusText = validImageConfigs.length === 0 
            ? `OK: empty canvas in ${totalTime.toFixed(2)} ms`
            : `OK: ${validImageConfigs.length} img in ${totalTime.toFixed(2)} ms ` +
              `(conv ${(convertMs + encodeMs).toFixed(2)} ms | ` +
              `task ${taskMs.toFixed(2)} ms)`;
          
          node.status({
            fill: 'green',
            shape: 'dot',
            text: statusText
          });
        }

        send(msg);
        done && done();
      } catch (err) {
        node.status({ fill: "red", shape: "ring", text: "Error" });
        node.warn(`Error during advanced mosaic processing: ${err.message}`);
        // Don't send message on error
        if (done) { done(); }
      }
    });
  }

  RED.nodes.registerType('advanced-mosaic', AdvancedMosaicNode);
};