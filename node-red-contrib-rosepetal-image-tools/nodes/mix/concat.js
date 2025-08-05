/**
 * Node‑RED logic for *rosepetal‑concat* (C++ backend).
 * Concatenates an array of images into ONE image according to the chosen
 * direction and padding / resizing strategy.
 *
 * Timing fields returned by C++:
 *   timing.convertMs · timing.taskMs · timing.encodeMs
 * …and the node status shows: OK … (conv X | task Y ms)
 */
const { performance } = require('perf_hooks');
const Cpp             = require('../../lib/cpp-bridge.js');

module.exports = function (RED) {
  const NodeUtils = require('../../lib/node-utils.js')(RED);

  function ConcatNode (config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.on('input', async (msg, send, done) => {
      try {
        const t0 = performance.now();
        node.status({});                                      // clear status

        /* ▸ Read images --------------------------------------------------- */
        const list = RED.util.getMessageProperty(msg, config.inputPath || 'payload');
        const imgs = Array.isArray(list) ? list : [ list ];   // always an array

        // Validate input images - concat expects array input
        if (!NodeUtils.validateListImage(imgs, node)) {
          // Warning already sent, don't send message
          return;
        }

        /* ▸ Options from the editor -------------------------------------- */
        const direction = config.direction;   // 'right' | 'left' | 'down' | 'up'
        const strategy  = config.strategy;    // 'pad-start' | 'pad-end' | 'pad-both' | 'resize'
        const outputFormat = config.outputFormat || 'raw';
        const outputQuality = config.outputQuality || 90;
        const pngOptimize = config.pngOptimize || false;
        const padColorHex = config.padColor    || '#000000';

        /* ▸ Single call to the C++ addon --------------------------------- */
        const { image, timing = {} } =
              await Cpp.concat(imgs, direction, strategy, padColorHex, outputFormat, outputQuality, pngOptimize);

        /* ▸ Write the single result back to msg -------------------------- */
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
        NodeUtils.handleNodeError(node, err, msg, done, 'concat processing');
      }
    });
  }

  RED.nodes.registerType('concat', ConcatNode);
};
