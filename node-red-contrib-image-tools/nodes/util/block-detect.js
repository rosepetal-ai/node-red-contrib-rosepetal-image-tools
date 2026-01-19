/**
 * @file Node-RED logic for the block-detect node.
 * Monitors the Node.js event loop delay to detect blocking work.
 */
const { performance, monitorEventLoopDelay } = require('perf_hooks');

module.exports = function(RED) {
  function BlockDetectNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    const intervalMs = sanitizeNumber(config.intervalMs, 1000, 100);
    const thresholdMs = sanitizeNumber(config.thresholdMs, 120, 1);
    const resolutionMs = 20; // Medium resolution for event-loop histogram (ms)
    const consecutive = Math.max(1, Math.round(sanitizeNumber(config.consecutive, 1, 1)));
    const cooldownMs = sanitizeNumber(config.cooldown, 30000, 1000);
    const showStats = config.showStats !== false;

    let overThresholdCount = 0;
    let lastAlertAt = 0;
    let timer = null;
    let histogram = null;
    let fallbackPrev = performance.now();
    let monitorAvailable = typeof monitorEventLoopDelay === 'function';

    if (monitorAvailable) {
      histogram = monitorEventLoopDelay({ resolution: resolutionMs });
      histogram.enable();
    } else {
      node.warn('monitorEventLoopDelay not available; falling back to coarse timer drift detection.');
    }

    node.status({ fill: 'grey', shape: 'ring', text: 'monitoring…' });

    timer = setInterval(() => {
      const stats = monitorAvailable
        ? readHistogramStats(histogram)
        : readFallbackStats();

      if (showStats) {
        const color = stats.max >= thresholdMs ? (stats.alert ? 'red' : 'yellow') : 'green';
        const shape = stats.max >= thresholdMs ? 'ring' : 'dot';
        node.status({
          fill: color,
          shape,
          text: `avg ${stats.mean.toFixed(1)}ms | max ${stats.max.toFixed(1)}ms`
        });
      } else {
        if (stats.alert) {
          node.status({ fill: 'red', shape: 'dot', text: 'blocking detected' });
        } else if (stats.max >= thresholdMs) {
          node.status({ fill: 'yellow', shape: 'ring', text: 'high loop delay' });
        } else {
          node.status({ fill: 'green', shape: 'dot', text: 'ok' });
        }
      }

      if (stats.max >= thresholdMs) {
        overThresholdCount += 1;
      } else {
        overThresholdCount = 0;
      }

      if (overThresholdCount >= consecutive) {
        const now = Date.now();
        if (now - lastAlertAt >= cooldownMs) {
          emitAlert(stats);
          lastAlertAt = now;
        }
        overThresholdCount = 0;
      }
    }, intervalMs);

    node.on('close', function() {
      if (timer) {
        clearInterval(timer);
      }
      if (histogram) {
        histogram.disable();
      }
    });

    function emitAlert(stats) {
      const message =
        `Detected potential blocking: max ${stats.max.toFixed(1)} ms ` +
        `(avg ${stats.mean.toFixed(1)} ms, min ${stats.min.toFixed(1)} ms, threshold ${thresholdMs} ms).`;

      node.warn(message);
    }

    function readHistogramStats(hist) {
      const mean = Number.isFinite(hist.mean) ? hist.mean / 1e6 : 0;
      const max = Number.isFinite(hist.max) ? hist.max / 1e6 : 0;
      const min = Number.isFinite(hist.min) ? hist.min / 1e6 : 0;
      hist.reset();
      return {
        mean,
        max,
        min,
        alert: max >= thresholdMs
      };
    }

    function readFallbackStats() {
      const now = performance.now();
      const delta = now - fallbackPrev;
      fallbackPrev = now;
      const delay = Math.max(0, delta - intervalMs);
      return {
        mean: delay,
        max: delay,
        min: delay,
        alert: delay >= thresholdMs
      };
    }
  }

  RED.nodes.registerType('block-detect', BlockDetectNode, {
    defaults: {
      name: { value: '' },
      intervalMs: { value: 1000 },
      thresholdMs: { value: 120 },
      consecutive: { value: 1 },
      cooldown: { value: 30000 },
      showStats: { value: true }
    }
  });
};

function sanitizeNumber(value, fallback, min) {
  const num = Number(value);
  if (Number.isFinite(num)) {
    return Math.max(min, num);
  }
  return fallback;
}
