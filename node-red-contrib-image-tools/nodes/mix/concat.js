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
      const inputPath = config.inputPath || 'payload';
      const outputPath = config.outputPath || 'payload';
      let firstImage = null;

      try {
        const t0 = performance.now();
        node.status({});                                      // clear status

        /* ▸ Read images --------------------------------------------------- */
        const { value: list, error: inputErr } =
          NodeUtils.safeGetMessageProperty(msg, inputPath);
        if (inputErr) {
          return NodeUtils.handleValidationErrorWithPassthrough(
            node,
            {
              message: `Invalid inputPath "${inputPath}": ${inputErr.message}`,
              hint: `Set inputPath to an existing msg property (e.g. "payload"), or ensure "${inputPath}" exists before this node.`,
              details: { inputPath, outputPath }
            },
            msg,
            send,
            done,
            { originalPayload: undefined, outputPath: null, outputType: 'preserve' }
          );
        }

        const imgs = Array.isArray(list) ? list : [list];   // always an array

        // Capture first image for error passthrough
        firstImage = imgs[0] || null;

        // Validate input images - concat expects array input
        if (!NodeUtils.validateListImage(imgs, node)) {
          return NodeUtils.handleValidationErrorWithPassthrough(
            node,
            {
              message: 'Invalid image list',
              hint: `Ensure "${inputPath}" is an array of valid images. Use the "image-in" node or pass Buffers/Raw image objects.`,
              details: { inputPath, outputPath }
            },
            msg,
            send,
            done,
            { originalPayload: firstImage, outputPath, outputType: 'single' }
          );
        }

        /* ▸ Options from the editor -------------------------------------- */
        const direction = config.direction;   // 'right' | 'left' | 'down' | 'up'
        const strategy  = config.strategy;    // 'pad-start' | 'pad-end' | 'pad-both' | 'resize'
        const outputFormat = config.outputFormat || 'raw';
        const outputQuality = parseInt(config.outputQuality) || 90;
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
          node, err, msg, send, done, 'concat processing',
          {
            originalPayload: firstImage,
            outputPath,
            outputType: 'single',
            context: { inputPath, outputPath }
          }
        );
      }
    });
  }

  RED.nodes.registerType('concat', ConcatNode);
};
