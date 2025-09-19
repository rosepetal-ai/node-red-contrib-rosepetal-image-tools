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
      try {
        const t0 = performance.now();
        node.status({});                                      // clear status

        /* ▸ Read image and masks array from message ------------------------ */
        // Get base image and masks array from specified paths
        const image = RED.util.getMessageProperty(msg, config.imagePath || 'payload.image');
        const masksArray = RED.util.getMessageProperty(msg, config.masksPath || 'payload');

        // Validate base image
        const baseImg = NodeUtils.validateImageStructure(image, node);
        if (!baseImg) {
          node.warn("Base image is invalid or missing");
          return;
        }

        // Smart format detection and normalization
        let normalizedMasksArray;

        if (Array.isArray(masksArray)) {
          // Check if it's already in the expected format [{ masks: [...] }]
          if (masksArray.length > 0 && masksArray[0].hasOwnProperty('masks')) {
            normalizedMasksArray = masksArray; // Already correct format
          } else if (masksArray.length > 0 && masksArray[0].hasOwnProperty('mask')) {
            // Direct array of mask objects
            normalizedMasksArray = [{ masks: masksArray }];
          } else {
            normalizedMasksArray = masksArray; // Keep as is for validation to catch errors
          }
        } else if (typeof masksArray === 'object' && masksArray !== null && masksArray.hasOwnProperty('masks')) {
          // Single object with masks property (your case)
          normalizedMasksArray = [masksArray];
        } else {
          node.warn("Masks input must be an array or an object with 'masks' property");
          return;
        }

        if (normalizedMasksArray.length === 0) {
          node.warn("Masks array is empty");
          return;
        }

        // Validate masks array structure in detail
        let totalMaskCount = 0;
        for (let elementIndex = 0; elementIndex < normalizedMasksArray.length; elementIndex++) {
          const element = normalizedMasksArray[elementIndex];

          if (!element || typeof element !== 'object') {
            node.warn(`Invalid element at index ${elementIndex}: expected object with 'masks' property`);
            return;
          }

          if (!element.hasOwnProperty('masks') || !Array.isArray(element.masks)) {
            node.warn(`Invalid element at index ${elementIndex}: 'masks' property must be an array`);
            return;
          }

          for (let maskIndex = 0; maskIndex < element.masks.length; maskIndex++) {
            const maskObj = element.masks[maskIndex];

            if (!maskObj || typeof maskObj !== 'object') {
              node.warn(`Invalid mask object at element[${elementIndex}].masks[${maskIndex}]: expected object`);
              return;
            }

            if (!maskObj.hasOwnProperty('mask') || !Array.isArray(maskObj.mask)) {
              node.warn(`Invalid mask object at element[${elementIndex}].masks[${maskIndex}]: 'mask' property must be an array`);
              return;
            }

            if (maskObj.mask.length === 0) {
              node.warn(`Empty mask array at element[${elementIndex}].masks[${maskIndex}]: mask[0] is required`);
              return;
            }

            if (!Array.isArray(maskObj.mask[0])) {
              node.warn(`Invalid mask coordinates at element[${elementIndex}].masks[${maskIndex}]: mask[0] must be an array of coordinate pairs`);
              return;
            }

            if (!maskObj.hasOwnProperty('class_name') || typeof maskObj.class_name !== 'string') {
              node.warn(`Invalid class_name at element[${elementIndex}].masks[${maskIndex}]: must be a non-empty string`);
              return;
            }

            if (maskObj.class_name.trim() === '') {
              node.warn(`Empty class_name at element[${elementIndex}].masks[${maskIndex}]: class name cannot be empty`);
              return;
            }

            // Validate coordinate format
            const coordinates = maskObj.mask[0];
            for (let i = 0; i < coordinates.length; i++) {
              const point = coordinates[i];
              if (!Array.isArray(point) || point.length !== 2) {
                node.warn(`Invalid coordinate at element[${elementIndex}].masks[${maskIndex}].mask[0][${i}]: expected [x, y] pair`);
                return;
              }

              const [x, y] = point;
              if (typeof x !== 'number' || typeof y !== 'number') {
                node.warn(`Invalid coordinate at element[${elementIndex}].masks[${maskIndex}].mask[0][${i}]: coordinates must be numbers`);
                return;
              }

              if (x < 0 || x > 1 || y < 0 || y > 1) {
                node.warn(`Invalid coordinate at element[${elementIndex}].masks[${maskIndex}].mask[0][${i}]: coordinates must be in range [0, 1]`);
                return;
              }
            }

            totalMaskCount++;
          }
        }

        if (totalMaskCount === 0) {
          node.warn("No valid masks found in input array");
          return;
        }

        /* ▸ Options from the editor -------------------------------------- */
        const maskStrength = Math.max(0, Math.min(100,
          config.globalMaskStrength !== undefined ? parseInt(config.globalMaskStrength) : 50)) / 100.0;
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
        const { image: result, timing = {} } =
              await Cpp.addMasks(
                baseImg,
                normalizedMasksArray,
                classColorMap,
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

        send(msg);
        done && done();
      } catch (err) {
        NodeUtils.handleNodeError(node, err, msg, done, 'add-masks processing');
      }
    });
  }

  RED.nodes.registerType('add-masks', AddMasksNode);
};