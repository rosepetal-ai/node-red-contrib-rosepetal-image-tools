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
      /* I/O paths */
      const inputPath = config.inputPath || 'payload';
      const inputPathType = config.inputPathType || 'msg';
      const outputPath = config.outputPath || 'payload';
      const outputPathType = config.outputPathType || 'msg';

      const { value: inputImages, error: inputErr } =
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

      const imageArrayForPassthrough = Array.isArray(inputImages) ? inputImages : [inputImages];
      const passthroughImage = imageArrayForPassthrough[0];

      try {
        const t0 = performance.now();
        node.status({});

        const outputFormat = config.outputFormat || 'raw';
        const outputQuality = parseInt(config.outputQuality) || 90;
        const pngOptimize = config.pngOptimize || false;
        const useSharpWebp = outputFormat === 'webp' && NodeUtils.hasAdvancedWebpOptions(config);
        const cppFormat = useSharpWebp ? 'raw' : outputFormat;

        /* Canvas configuration */
        const canvasWidth = Number(NodeUtils.resolveDimension(node, config.canvasWidthType, config.canvasWidth, msg));
        const canvasHeight = Number(NodeUtils.resolveDimension(node, config.canvasHeightType, config.canvasHeight, msg));
        const backgroundColor = config.backgroundColor || '#000000';
        const normalized = !!config.coordNorm;

        /* Position mappings */
        const positions = config.positions || [];
        
        /* Input images array */
        const imageArray = imageArrayForPassthrough;

        // Validate input images - mosaic expects array input
        if (!NodeUtils.validateListImage(imageArray, node)) {
          return NodeUtils.handleValidationErrorWithPassthrough(
            node,
            {
              message: 'Invalid image list',
              hint: `Ensure "${inputPath}" is an array of valid images. Use the "image-in" node or pass Buffers/Raw image objects.`,
              details: { inputPath, inputPathType, outputPath, outputPathType }
            },
            msg,
            send,
            done,
            { originalPayload: passthroughImage, outputPath, outputPathType, outputType: 'single' }
          );
        }

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
        let { image, timing = {} } = await CppProcessor.mosaic(
          imageArray,
          canvasWidth,
          canvasHeight,
          backgroundColor,
          validPositions,
          normalized,
          cppFormat,
          outputQuality,
          pngOptimize
        );

        if (useSharpWebp) {
          image = await NodeUtils.encodeWebpAdvanced(image, config);
        }

        /* Set output */
        NodeUtils.setOutputValue(node, msg, outputPath, outputPathType, image);

        /* Performance status - same format as other nodes */
        const { convertMs = 0, taskMs = 0, encodeMs = 0 } = timing;
        const totalTime = performance.now() - t0;
        
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
            
            const debugResult = await NodeUtils.debugImageDisplay(
              image, 
              outputFormat,
              outputQuality,
              node,
              debugEnabled,
              debugWidth
            );
            
            if (debugResult) {
              debugFormat = debugResult.formatMessage;
              // Update node status with debug info
              const positionsText = validPositions.length === 0 ? 'empty canvas' : `${validPositions.length} pos`;
              NodeUtils.setSuccessStatusWithDebug(node, 1, totalTime, {
                convertMs: convertMs,
                taskMs: taskMs,
                encodeMs: encodeMs
              }, `${debugFormat} (${positionsText})`);
            }
          } catch (debugError) {
            node.warn(`Debug display error: ${debugError.message}`);
          }
        }
        
        // Set regular status if debug not enabled or failed
        if (!debugFormat) {
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
        }

        NodeUtils.recordPerformanceMetrics(node, msg, timing, totalTime);

        send(msg);
        done && done();
      } catch (err) {
        NodeUtils.handleNodeErrorWithPassthrough(
          node, err, msg, send, done, 'mosaic processing',
          {
            originalPayload: passthroughImage,
            outputPath,
            outputPathType,
            outputType: 'single',
            context: { inputPath, inputPathType, outputPath, outputPathType }
          }
        );
      }
    });
  }

  RED.nodes.registerType('rp-mosaic', MosaicNode);
};
