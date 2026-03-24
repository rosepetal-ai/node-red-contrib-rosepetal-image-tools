/**
 * Node-RED logic for *rosepetal-add-bbs* (C++ backend).
 * Draws bounding boxes with optional labels on images for object detection visualization.
 * Supports class name and confidence display with customizable colors and styles.
 *
 * Timing fields returned by C++:
 *   timing.convertMs · timing.taskMs · timing.encodeMs
 * …and the node status shows: OK … (conv X | task Y ms)
 */
const { performance } = require('perf_hooks');
const Cpp = require('../../lib/cpp-bridge.js');

module.exports = function (RED) {
  const NodeUtils = require('../../lib/node-utils.js')(RED);

  function AddBBsNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.on('input', async (msg, send, done) => {
      // Capture original payload for error passthrough
      const outputPath = config.outputPath || 'payload';
      const imagePath = config.imagePath || 'payload.image';
      const boxesPath = config.boxesPath || 'payload';

      const { value: originalPayload, error: imagePathErr } =
        NodeUtils.safeGetMessageProperty(msg, imagePath);
      if (imagePathErr) {
        return NodeUtils.handleValidationErrorWithPassthrough(
          node,
          {
            message: `Invalid imagePath "${imagePath}": ${imagePathErr.message}`,
            hint: `Ensure "${imagePath}" exists on msg and contains an image.`,
            details: { imagePath, boxesPath, outputPath }
          },
          msg,
          send,
          done,
          { originalPayload: undefined, outputPath: null, outputType: 'preserve' }
        );
      }

      try {
        const t0 = performance.now();
        node.status({});                                      // clear status

        /* ▸ Read image and boxes from message -------------------------- */
        // Get base image and boxes array from specified paths
        const image = originalPayload;
        const { value: boxesArray, error: boxesErr } =
          NodeUtils.safeGetMessageProperty(msg, boxesPath);
        if (boxesErr) {
          return NodeUtils.handleValidationErrorWithPassthrough(
            node,
            {
              message: `Invalid boxesPath "${boxesPath}": ${boxesErr.message}`,
              hint: `Ensure "${boxesPath}" exists on msg and contains an array of boxes.`,
              details: { imagePath, boxesPath, outputPath }
            },
            msg,
            send,
            done,
            { originalPayload, outputPath, outputType: 'single' }
          );
        }

        // Validate base image
        const baseImg = NodeUtils.validateImageStructure(image, node);
        if (!baseImg) {
          return NodeUtils.handleValidationErrorWithPassthrough(
            node,
            {
              message: 'Base image is invalid or missing',
              hint: `Check that "${imagePath}" contains a valid image (Buffer or raw image object).`,
              details: { imagePath, boxesPath, outputPath }
            },
            msg,
            send,
            done,
            { originalPayload, outputPath, outputType: 'single' }
          );
        }

        // Validate boxes input - expect direct array format
        if (!Array.isArray(boxesArray)) {
          return NodeUtils.handleValidationErrorWithPassthrough(
            node,
            {
              message: 'Boxes input must be an array',
              hint: `Set "${boxesPath}" to an array of box objects (expected objects with "raw_boxes" and "tag").`,
              details: { boxesPath, outputPath }
            },
            msg,
            send,
            done,
            { originalPayload, outputPath, outputType: 'single' }
          );
        }

        if (boxesArray.length === 0) {
          const total = performance.now() - t0;
          RED.util.setMessageProperty(msg, config.outputPath || 'payload', baseImg);
          NodeUtils.setSuccessStatus(node, 0, total, { convertMs: 0, taskMs: 0, encodeMs: 0 });
          NodeUtils.recordPerformanceMetrics(node, msg, {
            convertMs: 0,
            encodeMs: 0,
            taskMs: 0
          }, total);
          send(msg);
          done && done();
          return;
        }

        // Validate boxes array structure in detail
        let totalBoxCount = 0;
        for (let boxIndex = 0; boxIndex < boxesArray.length; boxIndex++) {
          const boxObj = boxesArray[boxIndex];

          if (!boxObj || typeof boxObj !== 'object') {
            return NodeUtils.handleValidationErrorWithPassthrough(
              node, `Invalid box object at index ${boxIndex}: expected object`, msg, send, done,
              { originalPayload, outputPath, outputType: 'single' }
            );
          }

          if (!boxObj.hasOwnProperty('raw_boxes') || !Array.isArray(boxObj.raw_boxes)) {
            return NodeUtils.handleValidationErrorWithPassthrough(
              node, `Invalid box object at index ${boxIndex}: 'raw_boxes' property must be an array`, msg, send, done,
              { originalPayload, outputPath, outputType: 'single' }
            );
          }

          if (boxObj.raw_boxes.length !== 4) {
            return NodeUtils.handleValidationErrorWithPassthrough(
              node, `Invalid box format at index ${boxIndex}: expected 4 corner points`, msg, send, done,
              { originalPayload, outputPath, outputType: 'single' }
            );
          }

          // Compute axis-aligned bounding box from 4 corners (supports rotated boxes)
          const xs = boxObj.raw_boxes.map(p => p[0]);
          const ys = boxObj.raw_boxes.map(p => p[1]);
          const x1 = Math.min(...xs), x2 = Math.max(...xs);
          const y1 = Math.min(...ys), y2 = Math.max(...ys);

          // Check normalized range
          if (x1 < 0 || x2 > 1 || y1 < 0 || y2 > 1) {
            return NodeUtils.handleValidationErrorWithPassthrough(
              node, `Box coordinates out of range [0,1] at index ${boxIndex}`, msg, send, done,
              { originalPayload, outputPath, outputType: 'single' }
            );
          }

          if (!boxObj.hasOwnProperty('tag') || typeof boxObj.tag !== 'string') {
            return NodeUtils.handleValidationErrorWithPassthrough(
              node, `Invalid tag at index ${boxIndex}: must be a non-empty string`, msg, send, done,
              { originalPayload, outputPath, outputType: 'single' }
            );
          }

          if (boxObj.tag.trim() === '') {
            return NodeUtils.handleValidationErrorWithPassthrough(
              node, `Empty tag at index ${boxIndex}: tag cannot be empty`, msg, send, done,
              { originalPayload, outputPath, outputType: 'single' }
            );
          }

          totalBoxCount++;
        }

        if (totalBoxCount === 0) {
          const total = performance.now() - t0;
          RED.util.setMessageProperty(msg, config.outputPath || 'payload', baseImg);
          NodeUtils.setSuccessStatus(node, 0, total, { convertMs: 0, taskMs: 0, encodeMs: 0 });
          NodeUtils.recordPerformanceMetrics(node, msg, {
            convertMs: 0,
            encodeMs: 0,
            taskMs: 0
          }, total);
          send(msg);
          done && done();
          return;
        }

        /* ▸ Options from the editor -------------------------------------- */
        // Display options (showClassName and showConfidence default to true)
        const showClassName = config.showClassName !== false;
        const showConfidence = config.showConfidence !== false;
        const onlyMapped = config.onlyMapped === true;

        // Visual settings
        const boxThickness = Math.max(1, Math.min(10, parseInt(config.boxThickness) || 2));
        const fontSize = Math.max(0.3, Math.min(2.0, parseFloat(config.fontSize) || 0.5));
        const labelBackground = true; // Always enable background for readability

        // Output settings
        const outputFormat = config.outputFormat || 'raw';
        const outputQuality = parseInt(config.outputQuality) || 90;
        const pngOptimize = config.pngOptimize || false;
        const useSharpWebp = outputFormat === 'webp' && NodeUtils.hasAdvancedWebpOptions(config);
        const cppFormat = useSharpWebp ? 'raw' : outputFormat;

        // Build class color map from configuration
        const classColorMap = {};
        const classColorMappings = config.classColorMappings || [];

        for (const mapping of classColorMappings) {
          if (mapping.className && mapping.className.trim() !== '' && mapping.color) {
            classColorMap[mapping.className.trim()] = mapping.color;
          }
        }

        /* ▸ Single call to the C++ addon --------------------------------- */
        let { image: result, timing = {}, boxCount } =
              await Cpp.addBBs(
                baseImg,
                boxesArray,  // Pass direct array to C++
                classColorMap,
                showClassName,
                showConfidence,
                onlyMapped,
                boxThickness,
                fontSize,
                'above',  // Always position labels above the box
                labelBackground,
                cppFormat,
                outputQuality,
                pngOptimize
              );

        if (useSharpWebp) {
          result = await NodeUtils.encodeWebpAdvanced(result, config);
        }

        /* ▸ Write the result back to msg ---------------------------------- */
        RED.util.setMessageProperty(msg, config.outputPath || 'payload', result);

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
              result,
              outputFormat,
              outputQuality,
              node,
              debugEnabled,
              debugWidth
            );

            if (debugResult) {
              debugFormat = debugResult.formatMessage;
              // Update node status with debug info and box count
              NodeUtils.setSuccessStatusWithDebug(node, boxCount, total, timing, debugFormat);
            }
          } catch (debugError) {
            node.warn(`Debug display error: ${debugError.message}`);
          }
        }

        // Set regular status if debug not enabled or failed
        if (!debugFormat) {
          NodeUtils.setSuccessStatus(node, boxCount, total, timing);
        }

        NodeUtils.recordPerformanceMetrics(node, msg, timing || {}, total);

        send(msg);
        done && done();
      } catch (err) {
        NodeUtils.handleNodeErrorWithPassthrough(
          node, err, msg, send, done, 'add-bbs processing',
          {
            originalPayload,
            outputPath,
            outputType: 'single',
            context: { imagePath, boxesPath, outputPath }
          }
        );
      }
    });
  }

  RED.nodes.registerType('rp-add-bbs', AddBBsNode);
};
