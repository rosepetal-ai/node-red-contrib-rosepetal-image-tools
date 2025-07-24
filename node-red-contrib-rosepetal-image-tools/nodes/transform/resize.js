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
        const outputAsJpg = !!config.outputAsJpg;

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

          // Direct call to addon: (image, wMode, wVal, hMode, hVal, encodeJpg)
          return CppProcessor.resize(
            inputImage,
            config.widthMode,  wVal,
            config.heightMode, hVal,
            outputAsJpg
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
        
        NodeUtils.setSuccessStatus(node, results.length, elapsedTime, {
          convertMs: totalConvertMs,
          taskMs: totalTaskMs,
          encodeMs: encodeMs
        });

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
