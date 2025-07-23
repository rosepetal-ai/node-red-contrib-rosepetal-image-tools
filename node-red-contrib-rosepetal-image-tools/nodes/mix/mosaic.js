/**
 * Node-RED logic for *rosepetal-mosaic* (Ultra-optimized C++ backend).
 * Creates composite images by placing multiple images on a canvas at specified positions.
 * Super fast with zero-copy operations and parallel processing.
 */
const { performance } = require('perf_hooks');
const CppProcessor = require('../../lib/cpp-bridge.js');

module.exports = function (RED) {
  const NodeUtils = require('../../lib/node-utils.js')(RED);

  function MosaicNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.on('input', async (msg, send, done) => {
      try {
        const t0 = performance.now();
        node.status({});

        /* I/O paths */
        const inputPath = config.inputPath || 'payload';
        const outputPath = config.outputPath || 'payload';
        const outputAsJpg = !!config.outputAsJpg;

        /* Canvas configuration */
        const canvasWidth = Number(NodeUtils.resolveDimension(node, config.canvasWidthType, config.canvasWidth, msg));
        const canvasHeight = Number(NodeUtils.resolveDimension(node, config.canvasHeightType, config.canvasHeight, msg));
        const backgroundColor = config.backgroundColor || '#000000';
        const normalized = !!config.coordNorm;

        /* Position mappings */
        const positions = config.positions || [];
        
        /* Input images array */
        const inputImages = RED.util.getMessageProperty(msg, inputPath);
        const imageArray = Array.isArray(inputImages) ? inputImages : [inputImages];

        /* Validate positions - allow empty positions to show just background canvas */
        const validPositions = positions.filter(pos => {
          const arrayIndex = parseInt(pos.arrayIndex);
          return arrayIndex >= 0 && arrayIndex < imageArray.length;
        });

        // Note: Allow empty validPositions - this will create canvas with just background color

        /* Validate canvas dimensions */
        if (canvasWidth <= 0 || canvasHeight <= 0) {
          throw new Error('Canvas dimensions must be positive numbers');
        }

        /* Single ultra-fast C++ call */
        const { image, timing = {} } = await CppProcessor.mosaic(
          imageArray,
          canvasWidth,
          canvasHeight,
          backgroundColor,
          validPositions,
          normalized,
          outputAsJpg
        );

        /* Set output */
        RED.util.setMessageProperty(msg, outputPath, image);

        /* Performance status - same format as other nodes */
        const { convertMs = 0, taskMs = 0, encodeMs = 0 } = timing;
        const totalTime = performance.now() - t0;
        
        const statusText = validPositions.length === 0 
          ? `OK: empty canvas in ${totalTime.toFixed(2)} ms`
          : `OK: ${validPositions.length} pos in ${totalTime.toFixed(2)} ms ` +
            `(conv ${(convertMs + encodeMs).toFixed(2)} ms | ` +
            `task ${taskMs.toFixed(2)} ms)`;
        
        node.status({
          fill: 'green',
          shape: 'dot',
          text: statusText
        });

        send(msg);
        done && done();
      } catch (err) {
        NodeUtils.handleNodeError(node, err, msg, done);
      }
    });
  }

  RED.nodes.registerType('mosaic', MosaicNode);
};