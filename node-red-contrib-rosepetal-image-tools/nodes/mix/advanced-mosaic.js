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
        const propagateMasks = !!config.propagateMasks;
        const masksPath = config.masksPath || 'masks';
        const masksPathType = config.masksPathType || 'msg';
        const masksOutputPath = config.masksOutputPath || 'masks';
        const masksOutputPathType = config.masksOutputPathType || 'msg';

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

        /* Optional mask propagation */
        let masksArray = null;
        if (propagateMasks) {
          try {
            if (masksPathType === 'msg') {
              masksArray = RED.util.getMessageProperty(msg, masksPath);
            } else if (masksPathType === 'flow') {
              masksArray = node.context().flow.get(masksPath);
            } else if (masksPathType === 'global') {
              masksArray = node.context().global.get(masksPath);
            }
          } catch (e) {
            node.warn(`Failed to read masks from ${masksPathType}.${masksPath}: ${e.message}`);
          }

          if (!Array.isArray(masksArray)) {
            node.warn('Mask propagation enabled but masks input is not an array; skipping mask propagation.');
            masksArray = null;
          }
        }

        /* Single ultra-fast C++ call */
        const options = {
          outputFormat,
          quality: outputQuality,
          pngOptimize
        };
        if (masksArray) {
          options.masks = masksArray;
        }

        const { image, masks: transformedMasks, timing = {} } = await CppProcessor.advancedMosaic(
          imageArray,
          canvasWidth,
          canvasHeight,
          backgroundColor,
          validImageConfigs,
          normalized,
          options
        );

        const maskCount = Array.isArray(transformedMasks) ? transformedMasks.length : (propagateMasks && masksArray ? masksArray.length : 0);

        /* Set output */
        RED.util.setMessageProperty(msg, outputPath, image);
        if (propagateMasks && transformedMasks) {
          if (masksOutputPathType === 'msg') {
            RED.util.setMessageProperty(msg, masksOutputPath, transformedMasks);
          } else if (masksOutputPathType === 'flow') {
            node.context().flow.set(masksOutputPath, transformedMasks);
          } else if (masksOutputPathType === 'global') {
            node.context().global.set(masksOutputPath, transformedMasks);
          }
        }

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
            : `OK: ${validImageConfigs.length} img${maskCount ? `/${maskCount} mask` : ''} in ${totalTime.toFixed(2)} ms ` +
              `(conv ${(convertMs + encodeMs).toFixed(2)} ms | ` +
              `task ${taskMs.toFixed(2)} ms)`;
          
          node.status({
            fill: 'green',
            shape: 'dot',
            text: statusText
          });
        }

        NodeUtils.recordPerformanceMetrics(node, msg, timing, totalTime);

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
