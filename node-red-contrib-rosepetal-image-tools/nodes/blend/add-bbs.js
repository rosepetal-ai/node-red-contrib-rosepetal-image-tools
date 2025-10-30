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
      try {
        const t0 = performance.now();
        node.status({});                                      // clear status

        /* ▸ Read image and boxes from message -------------------------- */
        // Get base image and boxes array from specified paths
        const image = RED.util.getMessageProperty(msg, config.imagePath || 'payload.image');
        const boxesArray = RED.util.getMessageProperty(msg, config.boxesPath || 'payload');

        // Validate base image
        const baseImg = NodeUtils.validateImageStructure(image, node);
        if (!baseImg) {
          node.warn("Base image is invalid or missing");
          return;
        }

        // Validate boxes input - expect direct array format
        if (!Array.isArray(boxesArray)) {
          node.warn("Boxes input must be an array");
          return;
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
            node.warn(`Invalid box object at index ${boxIndex}: expected object`);
            return;
          }

          if (!boxObj.hasOwnProperty('raw_boxes') || !Array.isArray(boxObj.raw_boxes)) {
            node.warn(`Invalid box object at index ${boxIndex}: 'raw_boxes' property must be an array`);
            return;
          }

          if (boxObj.raw_boxes.length !== 4) {
            node.warn(`Invalid box format at index ${boxIndex}: expected 4 corner points`);
            return;
          }

          // Validate 4-corner format
          const [[x1, y1], [x2, y1_check], [x2_check, y2], [x1_check, y2_check]] = boxObj.raw_boxes;

          if (x2 !== x2_check || x1 !== x1_check || y1 !== y1_check || y2 !== y2_check) {
            node.warn(`Inconsistent corner points at index ${boxIndex}`);
            return;
          }

          // Check normalized range
          if (x1 < 0 || x1 > 1 || x2 < 0 || x2 > 1 || y1 < 0 || y1 > 1 || y2 < 0 || y2 > 1) {
            node.warn(`Box coordinates out of range [0,1] at index ${boxIndex}`);
            return;
          }

          if (!boxObj.hasOwnProperty('tag') || typeof boxObj.tag !== 'string') {
            node.warn(`Invalid tag at index ${boxIndex}: must be a non-empty string`);
            return;
          }

          if (boxObj.tag.trim() === '') {
            node.warn(`Empty tag at index ${boxIndex}: tag cannot be empty`);
            return;
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

        // Build class color map from configuration
        const classColorMap = {};
        const classColorMappings = config.classColorMappings || [];

        for (const mapping of classColorMappings) {
          if (mapping.className && mapping.className.trim() !== '' && mapping.color) {
            classColorMap[mapping.className.trim()] = mapping.color;
          }
        }

        /* ▸ Single call to the C++ addon --------------------------------- */
        const { image: result, timing = {}, boxCount } =
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
                outputFormat,
                outputQuality,
                pngOptimize
              );

        /* ▸ Write the result back to msg ---------------------------------- */
        RED.util.setMessageProperty(msg, config.outputPath || 'payload', result);

        /* ▸ Status: standardized success formatting ----------------------- */
        const total = performance.now() - t0;

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
              result,
              outputFormat,
              outputQuality,
              node,
              true,
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
        NodeUtils.handleNodeError(node, err, msg, done, 'add-bbs processing');
      }
    });
  }

  RED.nodes.registerType('add-bbs', AddBBsNode);
};
