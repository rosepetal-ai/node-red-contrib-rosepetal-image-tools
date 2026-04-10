/**
 * Node-RED logic for *rosepetal-heat-diff* (C++ backend).
 * Computes absolute difference between two images and applies a colormap
 * to produce a heat map visualization of the differences.
 *
 * Timing fields returned by C++:
 *   timing.convertMs . timing.taskMs . timing.encodeMs
 */
const { performance } = require('perf_hooks');
const Cpp             = require('../../lib/cpp-bridge.js');

// OpenCV COLORMAP constants
const COLORMAP = {
  'JET':      2,
  'HOT':      11,
  'INFERNO':  14,
  'TURBO':    20,
  'BONE':     1,
  'COOL':     8,
  'RAINBOW':  4,
  'OCEAN':    5,
  'PINK':     10,
  'HSV':      9
};

module.exports = function (RED) {
  const NodeUtils = require('../../lib/node-utils.js')(RED);

  function HeatDiffNode (config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.on('input', async (msg, send, done) => {
      const outputPath = config.outputPath || 'payload';
      const image1Path = config.image1Path || 'payload';
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
          msg, send, done,
          { originalPayload: undefined, outputPath: null, outputType: 'preserve' }
        );
      }

      const baseImageForPassthrough = image1;

      try {
        const t0 = performance.now();
        node.status({});

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
            msg, send, done,
            { originalPayload: baseImageForPassthrough, outputPath, outputType: 'single' }
          );
        }

        const img1 = NodeUtils.validateImageStructure(image1, node);
        if (!img1) {
          return NodeUtils.handleValidationErrorWithPassthrough(
            node,
            {
              message: 'First image is invalid or missing',
              hint: `Check that "${image1Path}" contains a valid image.`,
              details: { image1Path, image2Path, outputPath }
            },
            msg, send, done,
            { originalPayload: baseImageForPassthrough, outputPath, outputType: 'single' }
          );
        }

        const img2 = NodeUtils.validateImageStructure(image2, node);
        if (!img2) {
          return NodeUtils.handleValidationErrorWithPassthrough(
            node,
            {
              message: 'Second image is invalid or missing',
              hint: `Check that "${image2Path}" contains a valid image.`,
              details: { image1Path, image2Path, outputPath }
            },
            msg, send, done,
            { originalPayload: baseImageForPassthrough, outputPath, outputType: 'single' }
          );
        }

        /* Options from the editor */
        const colormapName = config.colormap || 'JET';
        const colormapType = COLORMAP[colormapName] !== undefined ? COLORMAP[colormapName] : 2;
        const blurSize = Math.max(0, parseInt(config.blurSize) || 0);
        const threshold = Math.max(0, Math.min(255, parseInt(config.threshold) || 0));
        const outputFormat = config.outputFormat || 'raw';
        const outputQuality = parseInt(config.outputQuality) || 90;
        const pngOptimize = config.pngOptimize || false;
        const useSharpWebp = outputFormat === 'webp' && NodeUtils.hasAdvancedWebpOptions(config);
        const cppFormat = useSharpWebp ? 'raw' : outputFormat;

        /* Single call to the C++ addon */
        let { image, timing = {} } =
          await Cpp.heatDiff(img1, img2, colormapType, blurSize, threshold,
                             cppFormat, outputQuality, pngOptimize);

        if (useSharpWebp) {
          image = await NodeUtils.encodeWebpAdvanced(image, config);
        }

        /* Write result */
        RED.util.setMessageProperty(msg, outputPath, image);

        /* Status */
        const total = performance.now() - t0;

        let debugFormat = null;
        const debugEnabled = config.debugEnabled === true || config.debugEnabled === 'true';
        if (debugEnabled) {
          try {
            let debugWidth = NodeUtils.resolveDimension(
              node,
              config.debugWidthType || 'num',
              config.debugWidth,
              msg
            );
            debugWidth = Math.max(1, parseInt(debugWidth) || 200);

            const debugResult = await NodeUtils.debugImageDisplay(
              image, outputFormat, outputQuality,
              node, debugEnabled, debugWidth
            );

            if (debugResult) {
              debugFormat = debugResult.formatMessage;
              NodeUtils.setSuccessStatusWithDebug(node, 1, total, timing, debugFormat);
            }
          } catch (debugError) {
            node.warn(`Debug display error: ${debugError.message}`);
          }
        }

        if (!debugFormat) {
          NodeUtils.setSuccessStatus(node, 1, total, timing);
        }

        NodeUtils.recordPerformanceMetrics(node, msg, timing || {}, total);

        send(msg);
        done && done();
      } catch (err) {
        NodeUtils.handleNodeErrorWithPassthrough(
          node, err, msg, send, done, 'heat-diff processing',
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

  RED.nodes.registerType('rp-heat-diff', HeatDiffNode);
};
