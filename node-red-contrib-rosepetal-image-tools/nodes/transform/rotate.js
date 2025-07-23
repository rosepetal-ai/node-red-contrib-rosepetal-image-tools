/**
 * Node-RED logic for *rosepetal-rotate* — always padding, timing formatted.
 */
const { performance } = require('perf_hooks');
const CppProcessor    = require('../../lib/cpp-bridge.js');

module.exports = function (RED) {
  const NodeUtils = require('../../lib/node-utils.js')(RED);

  function RotateNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.on('input', async (msg, send, done) => {
      try {
        const t0 = performance.now();
        node.status({});                                   // clear

        const inputPath   = config.inputPath  || 'payload';
        const outputPath  = config.outputPath || 'payload';
        const outputAsJpg = !!config.outputAsJpg;
        const padColorHex = config.padColor    || '#000000';

        const original = RED.util.getMessageProperty(msg, inputPath);
        const imgs     = Array.isArray(original) ? original : [original];

        /* ——— lanzar rotaciones en paralelo ——— */
        const promises = imgs.map(img => {
          let angle = NodeUtils.resolveDimension(
            node, config.angleType, config.angleValue, msg);
          angle = angle === null || angle === '' ? 0 : Number(angle);

          return CppProcessor.rotate(img, angle, padColorHex, outputAsJpg);
        });

        const results = await Promise.all(promises);

        /* ——— acumular métricas ——— */
        const { totalConvertMs, totalTaskMs, encodeMs, images } =
          results.reduce((acc, { image, timing }) => {
            acc.totalConvertMs += timing?.convertMs ?? 0;
            acc.totalTaskMs    += timing?.taskMs    ?? 0;
            acc.encodeMs       += timing?.encodeMs  ?? 0;
            acc.images.push(image);
            return acc;
          }, { totalConvertMs: 0, totalTaskMs: 0, encodeMs: 0, images: [] });

        const out   = Array.isArray(original) ? images : images[0];
        const durMs = performance.now() - t0;

        RED.util.setMessageProperty(msg, outputPath, out);

        /* ——— mismo formato que en resize ——— */
        node.status({
          fill  : 'green',
          shape : 'dot',
          text  : `OK: ${imgs.length} img in ${durMs.toFixed(2)} ms `
                + `(conv ${(totalConvertMs + encodeMs).toFixed(2)} ms `
                + `| task ${totalTaskMs.toFixed(2)} ms)`
        });

        send(msg);
        done && done();
      } catch (err) {
        NodeUtils.handleNodeError(node, err, msg, done);
      }
    });
  }

  RED.nodes.registerType('rotate', RotateNode);
};
