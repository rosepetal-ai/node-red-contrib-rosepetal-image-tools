/**
 * @file Node-RED logic for the resize node (C++-driven dimensions).
 * Works with single images or arrays transparently.
 * @author Rosepetal
 */
const { performance } = require('perf_hooks');
const CppProcessor = require('../../lib/cpp-bridge.js');

module.exports = function (RED) {
  const NodeUtils = require('../../lib/node-utils.js')(RED);

  function ResizeNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.on('input', async (msg, send, done) => {
      try {
        const startTime = performance.now();
        node.status({});
        const inputPath  = config.inputPath  || 'payload';
        const outputPath = config.outputPath || 'payload';
        const outputFormat = config.outputFormat || 'raw';
        const outputQuality = config.outputQuality || 90;

        const originalPayload = RED.util.getMessageProperty(msg, inputPath);
        const inputList = Array.isArray(originalPayload)
          ? originalPayload
          : [originalPayload];

        // Validate input images
        if (Array.isArray(originalPayload)) {
          if (!NodeUtils.validateListImage(originalPayload, node)) {
            // Warning already sent, don't send message
            return;
          }
        } else {
          if (!NodeUtils.validateSingleImage(originalPayload, node)) {
            // Warning already sent, don't send message
            return;
          }
        }

        const promises = inputList.map((inputImage) => {
          // Resolve dimension values (can come from msg/flow/global)
          let wVal = NodeUtils.resolveDimension(
            node,
            config.widthType,
            config.widthValue,
            msg
          );
          let hVal = NodeUtils.resolveDimension(
            node,
            config.heightType,
            config.heightValue,
            msg
          );

          // Convert to Number or NaN (C++ interprets NaN as "Auto")
          wVal = wVal === null || wVal === '' ? NaN : Number(wVal);
          hVal = hVal === null || hVal === '' ? NaN : Number(hVal);

          // Direct call to addon: (image, wMode, wVal, hMode, hVal, outputFormat, quality)
          return CppProcessor.resize(
            inputImage,
            config.widthMode,  wVal,
            config.heightMode, hVal,
            outputFormat,
            outputQuality
          );
        });
        const results = await Promise.all(promises);

        // Aggregate timings and prepare output
        const { totalConvertMs, totalTaskMs, encodeMs, images } =
          results.reduce(
            (acc, { image, timing }) => {
              acc.totalConvertMs += timing?.convertMs ?? 0;
              acc.totalTaskMs    += timing?.taskMs    ?? 0;
              acc.encodeMs       += timing?.encodeMs  ?? 0;
              acc.images.push(image);
              return acc;
            },
            { totalConvertMs: 0, totalTaskMs: 0, encodeMs: 0, images: [] }
          );

        const out = Array.isArray(originalPayload) ? images : images[0];
        const elapsedTime = performance.now() - startTime;
        
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
            
            // For arrays, show the first image as representative
            const debugImage = Array.isArray(originalPayload) ? images[0] : images[0];
            const debugResult = await NodeUtils.debugImageDisplay(
              debugImage, 
              outputFormat,
              outputQuality,
              node,
              true,
              debugWidth
            );
            
            if (debugResult) {
              debugFormat = debugResult.formatMessage;
              // Update node status with debug info
              NodeUtils.setSuccessStatusWithDebug(node, results.length, elapsedTime, {
                convertMs: totalConvertMs,
                taskMs: totalTaskMs,
                encodeMs: encodeMs
              }, debugFormat + (Array.isArray(originalPayload) ? ' (first)' : ''));
            }
          } catch (debugError) {
            node.warn(`Debug display error: ${debugError.message}`);
          }
        }
        
        // Set regular status if debug not enabled or failed
        if (!debugFormat) {
          NodeUtils.setSuccessStatus(node, results.length, elapsedTime, {
            convertMs: totalConvertMs,
            taskMs: totalTaskMs,
            encodeMs: encodeMs
          });
        }

        RED.util.setMessageProperty(msg, outputPath, out);

        send(msg);
        done && done();
      } catch (err) {
        NodeUtils.handleNodeError(node, err, msg, done, 'resize processing');
      }
    });
  }

  RED.nodes.registerType('resize', ResizeNode);
};
