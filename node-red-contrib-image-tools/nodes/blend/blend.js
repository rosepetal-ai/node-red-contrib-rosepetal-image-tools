/**
 * Node‑RED logic for *rosepetal‑blend* (C++ backend).
 * Blends two images with adjustable opacity using alpha blending.
 *
 * Timing fields returned by C++:
 *   timing.convertMs · timing.taskMs · timing.encodeMs
 * …and the node status shows: OK … (conv X | task Y ms)
 */
const { performance } = require('perf_hooks');
const Cpp             = require('../../lib/cpp-bridge.js');

module.exports = function (RED) {
  const NodeUtils = require('../../lib/node-utils.js')(RED);

  function BlendNode (config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.on('input', async (msg, send, done) => {
      // Capture output path for error passthrough
      const outputPath = config.outputPath || 'payload';
      const image1Path = config.image1Path || 'payload.image1';
      const image2Path = config.image2Path || 'payload.image2';

      const { value: image1, error: image1Err } =
        NodeUtils.safeGetMessageProperty(msg, image1Path);
      if (image1Err) {
        return NodeUtils.handleValidationErrorWithPassthrough(
          node,
          {
            message: `Invalid image1Path "${image1Path}": ${image1Err.message}`,
            hint: `Ensure "${image1Path}" exists on msg before this node.`,
            details: { image1Path, image2Path, outputPath }
          },
          msg,
          send,
          done,
          { originalPayload: undefined, outputPath: null, outputType: 'preserve' }
        );
      }

      // Base image passthrough (use first/base image)
      const baseImageForPassthrough = image1;

      try {
        const t0 = performance.now();
        node.status({});                                      // clear status

        /* ▸ Read images from message ------------------------------------ */
        const { value: image2, error: image2Err } =
          NodeUtils.safeGetMessageProperty(msg, image2Path);
        if (image2Err) {
          return NodeUtils.handleValidationErrorWithPassthrough(
            node,
            {
              message: `Invalid image2Path "${image2Path}": ${image2Err.message}`,
              hint: `Ensure "${image2Path}" exists on msg before this node.`,
              details: { image1Path, image2Path, outputPath }
            },
            msg,
            send,
            done,
            { originalPayload: baseImageForPassthrough, outputPath, outputType: 'single' }
          );
        }

        // Validate input images
        const img1 = NodeUtils.validateImageStructure(image1, node);
        if (!img1) {
          return NodeUtils.handleValidationErrorWithPassthrough(
            node,
            {
              message: 'First image is invalid or missing',
              hint: `Check that "${image1Path}" contains a valid image (Buffer or raw image object).`,
              details: { image1Path, image2Path, outputPath }
            },
            msg,
            send,
            done,
            { originalPayload: baseImageForPassthrough, outputPath, outputType: 'single' }
          );
        }

        const img2 = NodeUtils.validateImageStructure(image2, node);
        if (!img2) {
          return NodeUtils.handleValidationErrorWithPassthrough(
            node,
            {
              message: 'Second image is invalid or missing',
              hint: `Check that "${image2Path}" contains a valid image (Buffer or raw image object).`,
              details: { image1Path, image2Path, outputPath }
            },
            msg,
            send,
            done,
            { originalPayload: baseImageForPassthrough, outputPath, outputType: 'single' }
          );
        }

        /* ▸ Options from the editor -------------------------------------- */
        const opacity = Math.max(0, Math.min(100, parseInt(config.opacity) || 50)) / 100.0;
        const outputFormat = config.outputFormat || 'raw';
        const outputQuality = parseInt(config.outputQuality) || 90;
        const pngOptimize = config.pngOptimize || false;
        const useSharpWebp = outputFormat === 'webp' && NodeUtils.hasAdvancedWebpOptions(config);
        const cppFormat = useSharpWebp ? 'raw' : outputFormat;
        const alphaCompositing = config.alphaCompositing || false;
        const removeBackground = config.removeBackground || false;
        const backgroundColor = config.backgroundColor || '#ffffff';
        const colorTolerance = Math.max(0, Math.min(100, parseInt(config.colorTolerance) || 10)) / 100.0;

        /* ▸ Single call to the C++ addon --------------------------------- */
        let { image, timing = {} } =
              await Cpp.blend(img1, img2, opacity, cppFormat, outputQuality, pngOptimize,
                             alphaCompositing, removeBackground, backgroundColor, colorTolerance);

        if (useSharpWebp) {
          image = await NodeUtils.encodeWebpAdvanced(image, config);
        }

        /* ▸ Write the result back to msg ---------------------------------- */
        RED.util.setMessageProperty(msg, config.outputPath || 'payload', image);

        /* ▸ Status: standardized success formatting ----------------------- */
        const total = performance.now() - t0;
        
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
              NodeUtils.setSuccessStatusWithDebug(node, 1, total, timing, debugFormat);
            }
          } catch (debugError) {
            node.warn(`Debug display error: ${debugError.message}`);
          }
        }
        
        // Set regular status if debug not enabled or failed
        if (!debugFormat) {
          NodeUtils.setSuccessStatus(node, 1, total, timing);
        }

        NodeUtils.recordPerformanceMetrics(node, msg, timing || {}, total);

        send(msg);
        done && done();
      } catch (err) {
        NodeUtils.handleNodeErrorWithPassthrough(
          node, err, msg, send, done, 'blend processing',
          {
            originalPayload: baseImageForPassthrough,
            outputPath,
            outputType: 'single',
            context: { image1Path, image2Path, outputPath }
          }
        );
      }
    });
  }

  RED.nodes.registerType('rp-blend', BlendNode);
};
