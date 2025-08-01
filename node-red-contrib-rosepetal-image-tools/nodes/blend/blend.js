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
      try {
        const t0 = performance.now();
        node.status({});                                      // clear status

        /* ▸ Read images from message ------------------------------------ */
        // Get images directly from specified paths
        const image1 = RED.util.getMessageProperty(msg, config.image1Path || 'payload.image1');
        const image2 = RED.util.getMessageProperty(msg, config.image2Path || 'payload.image2');

        // Validate input images
        const img1 = NodeUtils.validateImageStructure(image1, node);
        if (!img1) {
          node.warn("First image is invalid or missing");
          return;
        }

        const img2 = NodeUtils.validateImageStructure(image2, node);
        if (!img2) {
          node.warn("Second image is invalid or missing");
          return;
        }

        /* ▸ Options from the editor -------------------------------------- */
        const opacity = Math.max(0, Math.min(100, parseInt(config.opacity) || 50)) / 100.0;
        const outputFormat = config.outputFormat || 'raw';
        const outputQuality = config.outputQuality || 90;

        /* ▸ Single call to the C++ addon --------------------------------- */
        const { image, timing = {} } =
              await Cpp.blend(img1, img2, opacity, outputFormat, outputQuality);

        /* ▸ Write the result back to msg ---------------------------------- */
        RED.util.setMessageProperty(msg, config.outputPath || 'payload', image);

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
              image, 
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

        send(msg);
        done && done();
      } catch (err) {
        NodeUtils.handleNodeError(node, err, msg, done, 'blend processing');
      }
    });
  }

  RED.nodes.registerType('blend', BlendNode);
};