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

        /* ▸ Options from the editor -------------------------------------- */
        const direction = config.direction;   // 'right' | 'left' | 'down' | 'up'
        const strategy  = config.strategy;    // 'pad-start' | 'pad-end' | 'pad-both' | 'resize'
        const asJpg     = !!config.outputAsJpg;

        /* ▸ Single call to the C++ addon --------------------------------- */
        const { image, timing = {} } =
              await Cpp.concat(imgs, direction, strategy, asJpg);

        /* ▸ Write the single result back to msg -------------------------- */
        RED.util.setMessageProperty(msg, config.outputPath || 'payload', image);

        /* ▸ Status: same format as resize / rotate ----------------------- */
        const { convertMs = 0, taskMs = 0, encodeMs = 0 } = timing;
        const total = performance.now() - t0;

        node.status({
          fill  : 'green',
          shape : 'dot',
          text  : `OK: 1 img in ${total.toFixed(2)} ms `
                + `(conv ${(convertMs + encodeMs).toFixed(2)} ms | `
                + `task ${taskMs.toFixed(2)} ms)`
        });

        send(msg);
        done && done();
      } catch (err) {
        NodeUtils.handleNodeError(node, err, msg, done);
      }
    });
  }

  RED.nodes.registerType('rosepetal-concat', ConcatNode);
};
