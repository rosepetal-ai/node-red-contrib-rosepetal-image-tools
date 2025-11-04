/**
 * @file Node.js logic for the Queue node providing buffering and rate limiting.
 */

module.exports = function (RED) {
  function QueueNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    /* ────────────────────────────
       ░░ 1.  Read configuration ░░
       ──────────────────────────── */
    const parsedMax = parseInt(config.maxQueueSize, 10);
    const parsedInterval = parseInt(config.intervalMilliseconds, 10);
    const parsedTimeout = parseInt(config.timeout, 10);

    node.maxQueueSize = Number.isInteger(parsedMax) && parsedMax > 0 ? parsedMax : 0;
    node.intervalMs =
      Number.isInteger(parsedInterval) && parsedInterval > 0 ? parsedInterval : 0;
    node.timeoutMs =
      Number.isInteger(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 0;

    /* ────────────────────────────
       ░░ 2.  Internal state      ░░
       ──────────────────────────── */
    const state = {
      queue: [],
      timer: null,
      lastSent: 0
    };

    setStatusIdle();

    /* ────────────────────────────
       ░░ 3.  Helper functions    ░░
       ──────────────────────────── */
    function setStatusIdle() {
      node.status({ fill: 'blue', shape: 'dot', text: 'Idle' });
    }

    function setStatusQueued() {
      node.status({
        fill: 'yellow',
        shape: 'dot',
        text: `Queued: ${state.queue.length}`
      });
    }

    function clearTimer() {
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
    }

    function pruneExpired() {
      if (node.timeoutMs <= 0 || state.queue.length === 0) {
        return 0;
      }

      const now = Date.now();
      let dropped = 0;

      while (state.queue.length > 0) {
        const oldest = state.queue[0];
        if (now - oldest.enqueuedAt >= node.timeoutMs) {
          state.queue.shift();
          dropped += 1;
        } else {
          break;
        }
      }

      if (dropped > 0) {
        node.warn(`Queue node dropped ${dropped} message(s) due to timeout.`);
      }

      return dropped;
    }

    function scheduleNextSend() {
      clearTimer();

      pruneExpired();

      if (state.queue.length === 0) {
        setStatusIdle();
        return;
      }

      const now = Date.now();
      const elapsed = state.lastSent ? now - state.lastSent : Number.POSITIVE_INFINITY;
      let delay = 0;

      if (node.intervalMs > 0 && Number.isFinite(elapsed) && elapsed < node.intervalMs) {
        delay = node.intervalMs - elapsed;
      }

      const sendFn = () => {
        state.timer = null;
        attemptSend();
      };

      state.timer = setTimeout(sendFn, Math.max(delay, 0));

      setStatusQueued();
    }

    function attemptSend() {
      pruneExpired();

      if (state.queue.length === 0) {
        setStatusIdle();
        return;
      }

      const now = Date.now();
      const elapsed = state.lastSent ? now - state.lastSent : Number.POSITIVE_INFINITY;

      if (node.intervalMs > 0 && Number.isFinite(elapsed) && elapsed < node.intervalMs) {
        scheduleNextSend();
        return;
      }

      const entry = state.queue.shift();
      if (!entry) {
        scheduleNextSend();
        return;
      }

      state.lastSent = now;
      node.status({
        fill: 'green',
        shape: 'dot',
        text: `Sending (remaining ${state.queue.length})`
      });

      node.send(entry.msg);
      scheduleNextSend();
    }

    /* ────────────────────────────
       ░░ 4.  Input handler       ░░
       ──────────────────────────── */
    node.on('input', function (msg, _send, done) {
      try {
        pruneExpired();

        if (
          node.maxQueueSize > 0 &&
          state.queue.length >= node.maxQueueSize
        ) {
          node.warn(
            `Queue node at capacity (${node.maxQueueSize}). Incoming message ignored.`
          );
          setStatusQueued();
          return done?.();
        }

        state.queue.push({ msg, enqueuedAt: Date.now() });
        setStatusQueued();
        attemptSend();
        done?.();
      } catch (err) {
        node.status({ fill: 'red', shape: 'ring', text: 'Error' });
        done ? done(err) : node.error(err, msg);
      }
    });

    /* ────────────────────────────
       ░░ 5.  Cleanup             ░░
       ──────────────────────────── */
    node.on('close', function () {
      clearTimer();
      state.queue.length = 0;
      setStatusIdle();
    });
  }

  RED.nodes.registerType('queue', QueueNode);
};
