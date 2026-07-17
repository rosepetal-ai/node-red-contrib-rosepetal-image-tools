/**
 * Node-RED logic for *rosepetal-heat-diff* (C++ backend).
 * Computes absolute difference between two images and applies a colormap
 * to produce a heat map visualization of the differences.
 * Accepts two single images or two same-length arrays (paired by index).
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
            { originalPayload: baseImageForPassthrough, outputPath, outputType: 'preserve' }
          );
        }

        // Both inputs must have the same shape: two singles, or two same-length arrays
        const isArray = Array.isArray(image1);
        if (isArray !== Array.isArray(image2)) {
          return NodeUtils.handleValidationErrorWithPassthrough(
            node,
            {
              message: 'image1 and image2 must both be single images or both be arrays',
              hint: `"${image1Path}" is ${isArray ? 'an array' : 'a single image'} but "${image2Path}" is not.`,
              details: { image1Path, image2Path, outputPath }
            },
            msg, send, done,
            { originalPayload: baseImageForPassthrough, outputPath, outputType: 'preserve' }
          );
        }
        if (isArray && (image1.length === 0 || image1.length !== image2.length)) {
          return NodeUtils.handleValidationErrorWithPassthrough(
            node,
            {
              message: `Image arrays must be non-empty and of equal length (got ${image1.length} and ${image2.length})`,
              hint: 'Images are paired by index; both arrays must contain the same number of images.',
              details: { image1Path, image2Path, outputPath }
            },
            msg, send, done,
            { originalPayload: baseImageForPassthrough, outputPath, outputType: 'preserve' }
          );
        }

        const list1 = (isArray ? image1 : [image1])
          .map(img => NodeUtils.validateImageStructure(img, node));
        if (list1.some(img => !img)) {
          return NodeUtils.handleValidationErrorWithPassthrough(
            node,
            {
              message: 'First image input is invalid or missing',
              hint: `Check that "${image1Path}" contains valid image(s).`,
              details: { image1Path, image2Path, outputPath }
            },
            msg, send, done,
            { originalPayload: baseImageForPassthrough, outputPath, outputType: 'preserve' }
          );
        }

        const list2 = (isArray ? image2 : [image2])
          .map(img => NodeUtils.validateImageStructure(img, node));
        if (list2.some(img => !img)) {
          return NodeUtils.handleValidationErrorWithPassthrough(
            node,
            {
              message: 'Second image input is invalid or missing',
              hint: `Check that "${image2Path}" contains valid image(s).`,
              details: { image1Path, image2Path, outputPath }
            },
            msg, send, done,
            { originalPayload: baseImageForPassthrough, outputPath, outputType: 'preserve' }
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

        /* One C++ call per pair (index-matched) */
        const results = await Promise.all(
          list1.map((img1, i) =>
            Cpp.heatDiff(img1, list2[i], colormapType, blurSize, threshold,
                         cppFormat, outputQuality, pngOptimize))
        );

        // Aggregate timings across pairs
        const timing = results.reduce(
          (acc, { timing: t }) => {
            acc.convertMs += t?.convertMs ?? 0;
            acc.taskMs    += t?.taskMs    ?? 0;
            acc.encodeMs  += t?.encodeMs  ?? 0;
            return acc;
          },
          { convertMs: 0, taskMs: 0, encodeMs: 0 }
        );
        const images = results.map(r => r.image);

        if (useSharpWebp) {
          for (let i = 0; i < images.length; i++) {
            images[i] = await NodeUtils.encodeWebpAdvanced(images[i], config);
          }
        }

        /* Write result — array in, array out */
        RED.util.setMessageProperty(msg, outputPath, isArray ? images : images[0]);

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

            // For arrays, show the first heat map as representative
            const debugResult = await NodeUtils.debugImageDisplay(
              images[0], outputFormat, outputQuality,
              node, debugEnabled, debugWidth
            );

            if (debugResult) {
              debugFormat = debugResult.formatMessage;
              NodeUtils.setSuccessStatusWithDebug(node, results.length, total, timing,
                debugFormat + (isArray ? ' (first)' : ''));
            }
          } catch (debugError) {
            node.warn(`Debug display error: ${debugError.message}`);
          }
        }

        if (!debugFormat) {
          NodeUtils.setSuccessStatus(node, results.length, total, timing);
        }

        NodeUtils.recordPerformanceMetrics(node, msg, timing, total);

        send(msg);
        done && done();
      } catch (err) {
        NodeUtils.handleNodeErrorWithPassthrough(
          node, err, msg, send, done, 'heat-diff processing',
          {
            originalPayload: baseImageForPassthrough,
            outputPath,
            outputType: 'preserve',
            context: { image1Path, image2Path, outputPath }
          }
        );
      }
    });
  }

  RED.nodes.registerType('rp-heat-diff', HeatDiffNode);
};
