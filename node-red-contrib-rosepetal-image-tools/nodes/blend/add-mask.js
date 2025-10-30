/**
 * Node‑RED logic for *rosepetal‑add‑mask* (C++ backend).
 * Applies a polygon-based mask to a base image using weighted blending with
 * configurable mask strength and colors.
 *
 * Timing fields returned by C++:
 *   timing.convertMs · timing.taskMs · timing.encodeMs
 * …and the node status shows: OK … (conv X | task Y ms)
 */
const { performance } = require('perf_hooks');
const Cpp             = require('../../lib/cpp-bridge.js');

module.exports = function (RED) {
  const NodeUtils = require('../../lib/node-utils.js')(RED);

  function AddMaskNode (config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.on('input', async (msg, send, done) => {
      try {
        const t0 = performance.now();
        node.status({});                                      // clear status

        /* ▸ Read image and polygon from message -------------------------- */
        // Get base image and polygon coordinates from specified paths
        const image = RED.util.getMessageProperty(msg, config.imagePath || 'payload.image');
        const polygon = RED.util.getMessageProperty(msg, config.polygonPath || 'payload.default.masks[0].mask[0]');

        // Validate base image
        const baseImg = NodeUtils.validateImageStructure(image, node);
        if (!baseImg) {
          node.warn("Base image is invalid or missing");
          return;
        }

        // Validate polygon coordinates
        if (!Array.isArray(polygon)) {
          node.warn("Polygon coordinates must be an array");
          return;
        }
        
        if (polygon.length === 0) {
          node.warn("Polygon coordinates array is empty");
          return;
        }
        
        // Validate polygon coordinate format
        for (let i = 0; i < polygon.length; i++) {
          const point = polygon[i];
          if (!Array.isArray(point) || point.length !== 2) {
            node.warn(`Invalid polygon coordinate at index ${i}: expected [x, y] pair`);
            return;
          }
          
          const [x, y] = point;
          if (typeof x !== 'number' || typeof y !== 'number') {
            node.warn(`Invalid polygon coordinate at index ${i}: coordinates must be numbers`);
            return;
          }
          
          if (x < 0 || x > 1 || y < 0 || y > 1) {
            node.warn(`Invalid polygon coordinate at index ${i}: coordinates must be in range [0, 1]`);
            return;
          }
        }

        /* ▸ Options from the editor -------------------------------------- */
        const maskStrength = Math.max(0, Math.min(100, parseInt(config.maskStrength) || 50)) / 100.0;
        const outputFormat = config.outputFormat || 'raw';
        const outputQuality = parseInt(config.outputQuality) || 90;
        const pngOptimize = config.pngOptimize || false;
        
        // Color processing
        const fillColor = config.fillColor || '#ffffff';
        
        // Convert hex color to RGB values
        let fillR = 255, fillG = 255, fillB = 255; // Default white
        if (fillColor.startsWith('#') && fillColor.length === 7) {
          fillR = parseInt(fillColor.substr(1, 2), 16);
          fillG = parseInt(fillColor.substr(3, 2), 16);
          fillB = parseInt(fillColor.substr(5, 2), 16);
        }

        /* ▸ Single call to the C++ addon --------------------------------- */
        const { image: result, timing = {} } =
              await Cpp.addMask(
                baseImg, 
                polygon, 
                maskStrength, 
                fillR, fillG, fillB,
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
        NodeUtils.handleNodeError(node, err, msg, done, 'add-mask processing');
      }
    });
  }

  RED.nodes.registerType('add-mask', AddMaskNode);
};
