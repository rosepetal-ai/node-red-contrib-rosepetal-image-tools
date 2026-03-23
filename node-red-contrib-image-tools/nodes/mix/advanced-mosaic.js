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
      /* I/O paths - needed early for error passthrough */
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

      const imageArray = Array.isArray(inputImages) ? inputImages : [inputImages];
      const firstImage = imageArray[0];

      try {
        const t0 = performance.now();
        node.status({});
        const outputFormat = config.outputFormat || 'raw';
        const outputQuality = parseInt(config.outputQuality) || 90;
        const pngOptimize = config.pngOptimize || false;
        const useSharpWebp = outputFormat === 'webp' && NodeUtils.hasAdvancedWebpOptions(config);
        const cppFormat = useSharpWebp ? 'raw' : outputFormat;
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

        // Validate input images - advanced mosaic expects array input
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
            { originalPayload: firstImage, outputPath, outputPathType, outputType: 'single' }
          );
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
            const { value, error } = NodeUtils.getInputValue(node, msg, masksPath, masksPathType);
            if (error) {
              node.warn(`Failed to read masks from ${masksPathType}.${masksPath}: ${error.message}`);
            } else {
              masksArray = value;
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
          outputFormat: cppFormat,
          quality: outputQuality,
          pngOptimize
        };
        if (masksArray) {
          options.masks = masksArray;
        }

        let { image, masks: transformedMasks, timing = {} } = await CppProcessor.advancedMosaic(
          imageArray,
          canvasWidth,
          canvasHeight,
          backgroundColor,
          validImageConfigs,
          normalized,
          options
        );

        if (useSharpWebp) {
          image = await NodeUtils.encodeWebpAdvanced(image, config);
        }

        const maskCount = Array.isArray(transformedMasks) ? transformedMasks.length : (propagateMasks && masksArray ? masksArray.length : 0);

        /* Set output */
        NodeUtils.setOutputValue(node, msg, outputPath, outputPathType, image);
        if (propagateMasks && transformedMasks) {
          NodeUtils.setOutputValue(node, msg, masksOutputPath, masksOutputPathType, transformedMasks);
        }

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
              const imageDims = imageArray.map(img => ({ width: img.width, height: img.height }));
              const transformMap = InfTx.makeAdvancedMosaicTransform({
                imageConfigs: validImageConfigs,
                canvasW: canvasWidth, canvasH: canvasHeight,
                imageDims, normalized
              });
              const transformed = await InfTx.applyMultiImageTransform(inferences, transformMap, CppProcessor);
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
          node, err, msg, send, done, 'advanced-mosaic processing',
          {
            originalPayload: firstImage,
            outputPath,
            outputPathType,
            outputType: 'single',
            context: { inputPath, inputPathType, outputPath, outputPathType }
          }
        );
      }
    });
  }

  RED.nodes.registerType('rp-advanced-mosaic', AdvancedMosaicNode);
};
