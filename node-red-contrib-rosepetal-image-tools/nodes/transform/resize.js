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

        const promises = inputList.map((inputImage) => {
          // Resolvemos los valores tal cual (pueden venir de msg/flow/global)
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

          // Convertir a Number o NaN (C++ interpreta NaN como “Auto”)
          wVal = wVal === null || wVal === '' ? NaN : Number(wVal);
          hVal = hVal === null || hVal === '' ? NaN : Number(hVal);

          // Llamada directa al addon: (image, wMode, wVal, hMode, hVal, encodeJpg)
          return CppProcessor.resize(
            inputImage,
            config.widthMode,  wVal,
            config.heightMode, hVal,
            outputAsJpg
          );
        });
        const results = await Promise.all(promises);

        // --- Agregar timings y preparar la salida --------------------
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
        node.status({
          fill: 'green',
          shape: 'dot',
          text: `OK: ${results.length} img in ${elapsedTime.toFixed(
            2
          )} ms (conv. ${(totalConvertMs + encodeMs).toFixed(
            2
          )} ms | task ${totalTaskMs.toFixed(2)} ms)`,
        });

        RED.util.setMessageProperty(msg, outputPath, out);

        send(msg);
        done && done();
      } catch (err) {
        NodeUtils.handleNodeError(node, err, msg, done);
      }
    });
  }

  RED.nodes.registerType('resize', ResizeNode);
};
