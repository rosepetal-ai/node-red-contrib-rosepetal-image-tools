/**
 * @file Node.js logic for the Array‑Out node with timeout, ordering and validation.
 * @author Rosepetal
 */

module.exports = function (RED) {
  function ArrayOutNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    /* ────────────────────────────
       ░░ 1.  Read & validate cfg ░░
       ──────────────────────────── */
    node.timeout       = parseInt(config.timeout) || 5000;
    node.expectedCount = parseInt(config.expectedCount);
    node.outputPath    = config.outputPath || 'payload';
    node.outputPathType = config.outputPathType || 'msg';

    if (!Number.isInteger(node.expectedCount) || node.expectedCount < 1) {
      node.error('Invalid expectedCount. Must be a positive integer.');
      node.expectedCount = 2; // sensible default
    }

    /* ────────────────────────────
       ░░ 2.  Internal state      ░░
       ──────────────────────────── */
    node.collection          = {};
    node.timeoutHandle       = null;
    node.isCollecting        = false;
    node.collectionStartTime = null;

    setStatusReady();

    /* ────────────────────────────
       ░░ 3.  Helper functions   ░░
       ──────────────────────────── */
    function setStatusReady() {
      node.status({
        fill: 'blue',
        shape: 'dot',
        text: `Ready (expect ${node.expectedCount})`
      });
    }

    function resetCollection() {
      if (node.timeoutHandle) {
        clearTimeout(node.timeoutHandle);
        node.timeoutHandle = null;
      }
      node.collection          = {};
      node.isCollecting        = false;
      node.collectionStartTime = null;
    }

    function handleTimeout() {
      const elapsed = Date.now() - node.collectionStartTime;
      resetCollection();
      node.status({
        fill: 'red',
        shape: 'ring',
        text: `Timeout after ${elapsed} ms – discarded`
      });
      setTimeout(setStatusReady, 3000);
    }

    function assembleAndOutput(sourceMsg) {
      const elapsed = Date.now() - node.collectionStartTime;

      /* Build the ordered array (fill gaps with null) */
      const result = Array.from({ length: node.expectedCount }, (_, i) =>
        node.collection.hasOwnProperty(i) ? node.collection[i] : null
      );

      /* Place the array where the user wants it */
      const outMsg = { ...sourceMsg }; // shallow‑clone to keep headers etc.
      if (node.outputPathType === 'msg') {
        RED.util.setMessageProperty(outMsg, node.outputPath, result, true);
      } else if (node.outputPathType === 'flow') {
        node.context().flow.set(node.outputPath, result);
      } else if (node.outputPathType === 'global') {
        node.context().global.set(node.outputPath, result);
      }

      node.status({
        fill: 'green',
        shape: 'dot',
        text: `Complete: ${result.length} (${elapsed} ms)`
      });
      node.send(outMsg);

      /* Return to ready after a short pause */
      setTimeout(setStatusReady, 2000);
      resetCollection();
    }

    /* ────────────────────────────
       ░░ 4.  Input handler      ░░
       ──────────────────────────── */
    node.on('input', function (msg, send, done) {
      try {
        /* 4.1  Basic sanity checks */
        if (!msg.meta || typeof msg.meta.arrayPosition !== 'number') {
          node.warn(
            'Message missing array metadata. Expected msg.meta.arrayPosition (number) from array‑in node'
          );
          return done?.();
        }

        const position = msg.meta.arrayPosition;

        /* 4.2  Validate range */
        if (position < 0 || position >= node.expectedCount) {
          node.warn(
            `Position ${position} out of range 0‑${node.expectedCount - 1}`
          );
          return done?.();
        }

        /* 4.3  Extract data – prefer meta.arrayData, fall back to payload */
        const data =
          msg.meta && msg.meta.arrayData !== undefined
            ? msg.meta.arrayData
            : msg.payload;

        /* 4.4  Start collection if first element */
        if (!node.isCollecting) {
          node.isCollecting        = true;
          node.collection          = {};
          node.collectionStartTime = Date.now();
          node.timeoutHandle       = setTimeout(handleTimeout, node.timeout);
          node.status({
            fill: 'yellow',
            shape: 'dot',
            text: 'Collecting… (1/' + node.expectedCount + ')'
          });
        }

        /* 4.5  Store element */
        node.collection[position] = data;

        /* 4.6  Update collecting status */
        const collected = Object.keys(node.collection).length;
        node.status({
          fill: 'yellow',
          shape: 'dot',
          text: `Collecting… (${collected}/${node.expectedCount})`
        });

        /* 4.7  Check completion */
        if (collected === node.expectedCount) {
          assembleAndOutput(msg);
        }

        done?.();
      } catch (err) {
        node.status({ fill: 'red', shape: 'ring', text: 'Error' });
        resetCollection();
        if (done) done(err);
        else node.error(err, msg);
      }
    });

    /* ────────────────────────────
       ░░ 5.  Cleanup            ░░
       ──────────────────────────── */
    node.on('close', function () {
      resetCollection();
      node.status({});
    });
  }

  RED.nodes.registerType('array-out', ArrayOutNode);
};
