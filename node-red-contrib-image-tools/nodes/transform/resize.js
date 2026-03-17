/**
 * @file Node-RED logic for the resize node (C++-driven dimensions).
 * Works with single images or arrays transparently.
 * @author Rosepetal
 */
const { performance } = require('perf_hooks');
const CppProcessor = require('../../lib/cpp-bridge.js');

module.exports = function (RED) {
  const NodeUtils = require('../../lib/node-utils.js')(RED);

  function ResizeNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.on('input', async (msg, send, done) => {
      const inputPath  = config.inputPath  || 'payload';
      const inputPathType = config.inputPathType || 'msg';
      const outputPath = config.outputPath || 'payload';
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
        const startTime = performance.now();
        node.status({});
        const outputFormat = config.outputFormat || 'raw';
        const outputQuality = parseInt(config.outputQuality) || 90;
        const pngOptimize = config.pngOptimize || false;
        const useSharpWebp = outputFormat === 'webp' && NodeUtils.hasAdvancedWebpOptions(config);
        const cppFormat = useSharpWebp ? 'raw' : outputFormat;
        const inputList = Array.isArray(originalPayload)
          ? originalPayload
          : [originalPayload];

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

        // Resolve dimension values once per message (can come from msg/flow/global)
        let wVal = NodeUtils.resolveDimension(
          node,
          config.widthType,
          config.widthValue,
          msg
        );
        let hVal = NodeUtils.resolveDimension(
          node,
          config.heightType,
          config.heightValue,
          msg
        );

        // Convert to Number; use 0 as "Auto" sentinel for the native addon.
        // (NaN is unsafe with -ffast-math builds and can lead to huge allocations.)
        wVal = wVal === null || wVal === '' ? 0 : Number(wVal);
        hVal = hVal === null || hVal === '' ? 0 : Number(hVal);

        if (!Number.isFinite(wVal) || !Number.isFinite(hVal)) {
          throw new Error('Resize width/height must be finite numbers');
        }

        const promises = inputList.map((inputImage) =>
          CppProcessor.resize(
            inputImage,
            config.widthMode,  wVal,
            config.heightMode, hVal,
            cppFormat,
            outputQuality,
            pngOptimize
          )
        );
        const results = await Promise.all(promises);

        // Aggregate timings and prepare output
        const { totalConvertMs, totalTaskMs, encodeMs, images } =
          results.reduce(
            (acc, { image, timing }) => {
              acc.totalConvertMs += timing?.convertMs ?? 0;
              acc.totalTaskMs    += timing?.taskMs    ?? 0;
              acc.encodeMs       += timing?.encodeMs  ?? 0;
              acc.images.push(image);
              return acc;
            },
            { totalConvertMs: 0, totalTaskMs: 0, encodeMs: 0, images: [] }
          );

        if (useSharpWebp) {
          for (let i = 0; i < images.length; i++) {
            images[i] = await NodeUtils.encodeWebpAdvanced(images[i], config);
          }
        }

        const out = Array.isArray(originalPayload) ? images : images[0];
        const elapsedTime = performance.now() - startTime;
        
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
              NodeUtils.setSuccessStatusWithDebug(node, results.length, elapsedTime, {
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
          NodeUtils.setSuccessStatus(node, results.length, elapsedTime, {
            convertMs: totalConvertMs,
            taskMs: totalTaskMs,
            encodeMs: encodeMs
          });
        }

        NodeUtils.recordPerformanceMetrics(node, msg, {
          convertMs: totalConvertMs,
          encodeMs: encodeMs,
          taskMs: totalTaskMs
        }, elapsedTime);

        NodeUtils.setOutputValue(node, msg, outputPath, outputPathType, out);

        send(msg);
        done && done();
      } catch (err) {
        NodeUtils.handleNodeErrorWithPassthrough(
          node, err, msg, send, done, 'resize processing',
          { originalPayload, outputPath, outputPathType, outputType: 'preserve' }
        );
      }
    });
  }

  RED.nodes.registerType('rp-resize', ResizeNode);
};
