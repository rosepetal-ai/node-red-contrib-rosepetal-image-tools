/**
 * Node‑RED logic for *rosepetal‑add‑masks* (C++ backend).
 * Applies multiple polygon-based masks to a base image using weighted blending with
 * configurable mask strength and class-based color mapping.
 *
 * Timing fields returned by C++:
 *   timing.convertMs · timing.taskMs · timing.encodeMs
 * …and the node status shows: OK … (conv X | task Y ms)
 */
const { performance } = require('perf_hooks');
const Cpp             = require('../../lib/cpp-bridge.js');

module.exports = function (RED) {
  const NodeUtils = require('../../lib/node-utils.js')(RED);

  function AddMasksNode (config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.on('input', async (msg, send, done) => {
      // Capture original payload for error passthrough
      const outputPath = config.outputPath || 'payload';
      const image = RED.util.getMessageProperty(msg, config.imagePath || 'payload.image');
      const originalPayload = image;

      try {
        const t0 = performance.now();
        node.status({});                                      // clear status

        /* ▸ Read image and masks array from message ------------------------ */
        // Get base image and masks array from specified paths
        const masksArray = RED.util.getMessageProperty(msg, config.masksPath || 'payload');

        // Validate base image
        const baseImg = NodeUtils.validateImageStructure(image, node);
        if (!baseImg) {
          return NodeUtils.handleValidationErrorWithPassthrough(
            node, 'Base image is invalid or missing', msg, send, done,
            { originalPayload, outputPath, outputType: 'single' }
          );
        }

        // Validate masks array - expect direct array format
        if (!Array.isArray(masksArray)) {
          return NodeUtils.handleValidationErrorWithPassthrough(
            node, 'Masks input must be an array', msg, send, done,
            { originalPayload, outputPath, outputType: 'single' }
          );
        }

        if (masksArray.length === 0) {
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

        const getClassName = (maskObj) => {
          const fields = ['tag', 'class_name', 'className', 'label', 'class'];
          for (const field of fields) {
            if (typeof maskObj[field] === 'string' && maskObj[field].trim() !== '') {
              return maskObj[field].trim();
            }
          }
          return null;
        };

        const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

        const validate2DMask = (matrix) => {
          if (!Array.isArray(matrix) || matrix.length === 0) return false;
          for (let y = 0; y < matrix.length; y++) {
            const row = matrix[y];
            if (!Array.isArray(row) || row.length === 0) return false;
            for (let x = 0; x < row.length; x++) {
              if (!isFiniteNumber(row[x])) {
                return false;
              }
            }
          }
          return true;
        };

        const countMasksInValue = (maskVal) => {
          if (!maskVal) return 0;

          // Raw image mask from inferencer (rgba buffer with width/height)
          if (maskVal.data && maskVal.width && maskVal.height) {
            return NodeUtils.validateImageStructure(maskVal, node) ? 1 : 0;
          }

          // 2D matrix or array of 2D matrices
          if (Array.isArray(maskVal) && maskVal.length > 0) {
            const first = maskVal[0];
            if (Array.isArray(first) && first.length > 0 && Array.isArray(first[0])) {
              // Possibly array of masks
              let validCount = 0;
              for (const candidate of maskVal) {
                if (validate2DMask(candidate)) validCount++;
              }
              return validCount;
            }
            return validate2DMask(maskVal) ? 1 : 0;
          }

          return 0;
        };

        // Validate masks array structure in detail
        let totalMaskCount = 0;
        for (let maskIndex = 0; maskIndex < masksArray.length; maskIndex++) {
          const maskObj = masksArray[maskIndex];

          if (!maskObj || typeof maskObj !== 'object') {
            return NodeUtils.handleValidationErrorWithPassthrough(
              node, `Invalid mask object at index ${maskIndex}: expected object`, msg, send, done,
              { originalPayload, outputPath, outputType: 'single' }
            );
          }

          const className = getClassName(maskObj);
          if (!className) {
            return NodeUtils.handleValidationErrorWithPassthrough(
              node, `Mask at index ${maskIndex} is missing a valid class/tag field`, msg, send, done,
              { originalPayload, outputPath, outputType: 'single' }
            );
          }

          const hasPolygons = Array.isArray(maskObj.polygons);
          const hasMaskField = Object.prototype.hasOwnProperty.call(maskObj, 'mask');

          if (!hasPolygons && !hasMaskField) {
            return NodeUtils.handleValidationErrorWithPassthrough(
              node, `Mask at index ${maskIndex} must include either 'polygons' or 'mask'`, msg, send, done,
              { originalPayload, outputPath, outputType: 'single' }
            );
          }

          let entryValid = false;

          if (hasPolygons) {
            // Validate coordinate format for all polygons in this mask
            for (let polyIdx = 0; polyIdx < maskObj.polygons.length; polyIdx++) {
              const coordinates = maskObj.polygons[polyIdx];
              if (!Array.isArray(coordinates)) {
                return NodeUtils.handleValidationErrorWithPassthrough(
                  node, `Invalid polygon at index ${maskIndex}.polygons[${polyIdx}]: expected an array of coordinate pairs`, msg, send, done,
                  { originalPayload, outputPath, outputType: 'single' }
                );
              }

              if (coordinates.length === 0) {
                return NodeUtils.handleValidationErrorWithPassthrough(
                  node, `Empty polygon at index ${maskIndex}.polygons[${polyIdx}]: at least one coordinate is required`, msg, send, done,
                  { originalPayload, outputPath, outputType: 'single' }
                );
              }

              for (let i = 0; i < coordinates.length; i++) {
                const point = coordinates[i];
                if (!Array.isArray(point) || point.length !== 2) {
                  return NodeUtils.handleValidationErrorWithPassthrough(
                    node, `Invalid coordinate at index ${maskIndex}.polygons[${polyIdx}][${i}]: expected [x, y] pair`, msg, send, done,
                    { originalPayload, outputPath, outputType: 'single' }
                  );
                }

                const [x, y] = point;
                if (!isFiniteNumber(x) || !isFiniteNumber(y)) {
                  return NodeUtils.handleValidationErrorWithPassthrough(
                    node, `Invalid coordinate at index ${maskIndex}.polygons[${polyIdx}][${i}]: coordinates must be numbers`, msg, send, done,
                    { originalPayload, outputPath, outputType: 'single' }
                  );
                }

                if (x < 0 || x > 1 || y < 0 || y > 1) {
                  return NodeUtils.handleValidationErrorWithPassthrough(
                    node, `Invalid coordinate at index ${maskIndex}.polygons[${polyIdx}][${i}]: coordinates must be in range [0, 1]`, msg, send, done,
                    { originalPayload, outputPath, outputType: 'single' }
                  );
                }
              }

              entryValid = true;
              totalMaskCount++;
            }
          }

          if (!entryValid && hasMaskField) {
            const maskCount = countMasksInValue(maskObj.mask);
            if (maskCount === 0) {
              return NodeUtils.handleValidationErrorWithPassthrough(
                node, `Invalid mask data at index ${maskIndex}: expected raw mask image or 2D matrix`, msg, send, done,
                { originalPayload, outputPath, outputType: 'single' }
              );
            }
            totalMaskCount += maskCount;
            entryValid = true;
          }

          if (!entryValid) {
            return NodeUtils.handleValidationErrorWithPassthrough(
              node, `No valid polygons or mask found at index ${maskIndex}`, msg, send, done,
              { originalPayload, outputPath, outputType: 'single' }
            );
          }
        }

        if (totalMaskCount === 0) {
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
        const maskStrength = Math.max(0, Math.min(100,
          config.globalMaskStrength !== undefined ? parseInt(config.globalMaskStrength) : 50)) / 100.0;
        const outputFormat = config.outputFormat || 'raw';
        const outputQuality = parseInt(config.outputQuality) || 90;
        const pngOptimize = config.pngOptimize || false;

        // Build class color map and priority order from configuration
        const classColorMap = {};
        const classPriorityOrder = [];  // Preserves order for priority-based painting
        const classColorMappings = config.classColorMappings || [];

        for (const mapping of classColorMappings) {
          if (mapping.className && mapping.className.trim() !== '' && mapping.color) {
            const cls = mapping.className.trim();
            classColorMap[cls] = mapping.color;
            classPriorityOrder.push(cls);  // First in list = highest priority
          }
        }

        /* ▸ Single call to the C++ addon --------------------------------- */
        const { image: result, timing = {} } =
              await Cpp.addMasks(
                baseImg,
                masksArray,
                classColorMap,
                classPriorityOrder,  // Priority order for overlap resolution
                maskStrength,
                true, // Always auto-generate colors for undefined classes
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
              // Update node status with debug info and mask count
              NodeUtils.setSuccessStatusWithDebug(node, totalMaskCount, total, timing, debugFormat);
            }
          } catch (debugError) {
            node.warn(`Debug display error: ${debugError.message}`);
          }
        }

        // Set regular status if debug not enabled or failed
        if (!debugFormat) {
          NodeUtils.setSuccessStatus(node, totalMaskCount, total, timing);
        }

        NodeUtils.recordPerformanceMetrics(node, msg, timing || {}, total);

        send(msg);
        done && done();
      } catch (err) {
        NodeUtils.handleNodeErrorWithPassthrough(
          node, err, msg, send, done, 'add-masks processing',
          { originalPayload, outputPath, outputType: 'single' }
        );
      }
    });
  }

  RED.nodes.registerType('add-masks', AddMasksNode);
};
