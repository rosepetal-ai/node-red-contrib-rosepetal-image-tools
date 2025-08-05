/**
 * @file Node-RED logic for the Filter node with C++ backend
 * Applies various image processing kernels: blur, sharpen, edge, emboss, gaussian
 * @author Rosepetal
 */
const { performance } = require('perf_hooks');
const CppProcessor = require('../../lib/cpp-bridge.js');

module.exports = function (RED) {
  const NodeUtils = require('../../lib/node-utils.js')(RED);

  function FilterNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.on('input', async (msg, send, done) => {
      try {
        const startTime = performance.now();
        node.status({});

        // I/O paths
        const inputPath = config.inputPath || 'payload';
        const outputPath = config.outputPath || 'payload';
        const outputFormat = config.outputFormat || 'raw';
        const outputQuality = parseInt(config.outputQuality) || 90;
        const pngOptimize = config.pngOptimize || false;

        // Filter parameters
        const filterType = config.filterType || 'blur';
        
        // Resolve kernel size and intensity from config
        let kernelSize = parseInt(NodeUtils.resolveDimension(
          node,
          config.kernelSizeType || 'num',
          config.kernelSize || '3',
          msg
        ));
        
        let intensity = parseFloat(NodeUtils.resolveDimension(
          node,
          config.intensityType || 'num',
          config.intensity || '1.0',
          msg
        ));

        // Validate parameters
        kernelSize = Math.max(3, Math.min(kernelSize, 15));
        if (kernelSize % 2 === 0) kernelSize++; // Ensure odd size
        intensity = Math.max(0.0, Math.min(intensity, 2.0));

        // Get input image(s)
        const originalPayload = RED.util.getMessageProperty(msg, inputPath);
        
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
        
        const inputList = Array.isArray(originalPayload)
          ? originalPayload
          : [originalPayload];

        // Process images in parallel
        const promises = inputList.map((inputImage) => {
          return CppProcessor.filter(
            inputImage,
            filterType,
            kernelSize,
            intensity,
            outputFormat,
            outputQuality,
            pngOptimize
          );
        });

        const results = await Promise.all(promises);

        // Aggregate timing information
        const { totalConvertMs, totalTaskMs, encodeMs, images } =
          results.reduce(
            (acc, { image, timing }) => {
              acc.totalConvertMs += timing?.convertMs ?? 0;
              acc.totalTaskMs += timing?.taskMs ?? 0;
              acc.encodeMs += timing?.encodeMs ?? 0;
              acc.images.push(image);
              return acc;
            },
            { totalConvertMs: 0, totalTaskMs: 0, encodeMs: 0, images: [] }
          );

        // Prepare output
        const output = Array.isArray(originalPayload) ? images : images[0];

        // Update node status with timing information
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
          node.status({
            fill: 'green',
            shape: 'dot',
            text: `OK: ${results.length} img in ${elapsedTime.toFixed(2)} ms (conv. ${(totalConvertMs + encodeMs).toFixed(2)} ms | task ${totalTaskMs.toFixed(2)} ms)`
          });
        }

        // Set output and send message
        RED.util.setMessageProperty(msg, outputPath, output);
        send(msg);
        done && done();

      } catch (err) {
        node.status({ fill: "red", shape: "ring", text: "Error" });
        node.warn(`Error during filter processing: ${err.message}`);
        // Don't send message on error
        if (done) { done(); }
      }
    });
  }

  RED.nodes.registerType('filter', FilterNode);
};