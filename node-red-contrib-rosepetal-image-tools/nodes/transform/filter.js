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
        const outputAsJpg = !!config.outputAsJpg;

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
            outputAsJpg
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
        node.status({
          fill: 'green',
          shape: 'dot',
          text: `OK: ${results.length} img in ${elapsedTime.toFixed(2)} ms (conv. ${(totalConvertMs + encodeMs).toFixed(2)} ms | task ${totalTaskMs.toFixed(2)} ms)`
        });

        // Set output and send message
        RED.util.setMessageProperty(msg, outputPath, output);
        send(msg);
        done && done();

      } catch (err) {
        NodeUtils.handleNodeError(node, err, msg, done);
      }
    });
  }

  RED.nodes.registerType('rosepetal-filter', FilterNode);
};