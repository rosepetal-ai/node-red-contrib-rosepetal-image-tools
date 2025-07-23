/**
 * Node‑RED logic for *rosepetal‑padding* (C++ backend)
 * Shows timings like the rest of the Rosepetal nodes.
 */
const { performance } = require('perf_hooks');
const CppProcessor    = require('../../lib/cpp-bridge.js');

module.exports = function (RED) {
  const NodeUtils = require('../../lib/node-utils.js')(RED);

  function PaddingNode(cfg) {
    RED.nodes.createNode(this, cfg);
    const node = this;

    node.on('input', async (msg, send, done) => {
      try {
        const t0 = performance.now();
        node.status({});

        /* paths */
        const inPath  = cfg.inputPath  || 'payload';
        const outPath = cfg.outputPath || 'payload';

        /* image / array */
        const rawIn = RED.util.getMessageProperty(msg, inPath);
        const imgs  = Array.isArray(rawIn) ? rawIn : [rawIn];

        /* static options from editor */
        const jpg      = !!cfg.outputAsJpg;
        const padHex   = cfg.padColor || '#000000';

        /* numeric margins can come from msg / flow / global */
        const tVal = Number(NodeUtils.resolveDimension(node, cfg.topType,    cfg.top,    msg));
        const bVal = Number(NodeUtils.resolveDimension(node, cfg.bottomType, cfg.bottom, msg));
        const lVal = Number(NodeUtils.resolveDimension(node, cfg.leftType,   cfg.left,   msg));
        const rVal = Number(NodeUtils.resolveDimension(node, cfg.rightType,  cfg.right,  msg));

        /* one C++ call per image (fast, runs in parallel) */
        const tasks = imgs.map(img =>
          CppProcessor.padding(img, tVal, bVal, lVal, rVal, padHex, jpg)
        );
        const results = await Promise.all(tasks);

        /* collect timings */
        let cMs = 0, tMs = 0, eMs = 0;
        const outImgs = results.map(r => {
          cMs += r.timing.convertMs;
          tMs += r.timing.taskMs;
          eMs += r.timing.encodeMs;
          return r.image;
        });

        RED.util.setMessageProperty(msg, outPath, Array.isArray(rawIn) ? outImgs : outImgs[0]);

        /* node status */
        node.status({
          fill:'green', shape:'dot',
          text:`OK: ${imgs.length} img in ${(performance.now()-t0).toFixed(2)} ms `
              + `(conv ${(cMs+eMs).toFixed(2)} | task ${tMs.toFixed(2)} ms)`
        });

        send(msg); done && done();
      } catch (err) {
        NodeUtils.handleNodeError(node, err, msg, done);
      }
    });
  }

  RED.nodes.registerType('padding', PaddingNode);
};
