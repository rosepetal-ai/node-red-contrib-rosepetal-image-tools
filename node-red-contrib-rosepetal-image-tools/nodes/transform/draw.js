/**
 * Node-RED logic for the draw node.
 * Overlays points and lines on an input image using the C++ backend.
 */
const { performance } = require('perf_hooks');
const CppProcessor = require('../../lib/cpp-bridge.js');

module.exports = function (RED) {
  const NodeUtils = require('../../lib/node-utils.js')(RED);

  function DrawNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.on('input', async (msg, send, done) => {
      try {
        const startTime = performance.now();
        node.status({});

        const inputPath = config.inputPath || 'payload';
        const outputPath = config.outputPath || 'payload';
        const outputFormat = config.outputFormat || 'raw';
        const outputQuality = parseInt(config.outputQuality, 10) || 90;
        const pngOptimize = config.pngOptimize || false;

        const image = RED.util.getMessageProperty(msg, inputPath);
        const baseImage = NodeUtils.validateImageStructure(image, node);
        if (!baseImage) {
          node.warn('Input image is invalid or missing');
          return;
        }

        const resolvedPoints = resolvePoints(config.points || [], msg);
        const resolvedLines = resolveLines(config.lines || [], msg);

        if (!resolvedPoints.length && !resolvedLines.length) {
          node.warn('No valid points or lines configured. Outputting original image.');
        }

        const { image: resultImage, timing = {} } = await CppProcessor.draw(
          baseImage,
          resolvedPoints,
          resolvedLines,
          outputFormat,
          outputQuality,
          pngOptimize
        );

        RED.util.setMessageProperty(msg, outputPath, resultImage);

        const elapsed = performance.now() - startTime;
        let debugFormat = null;

        if (config.debugEnabled) {
          try {
            let debugWidth = NodeUtils.resolveDimension(
              node,
              config.debugWidthType,
              config.debugWidth,
              msg
            );
            debugWidth = Math.max(1, parseInt(debugWidth, 10) || 200);

            const debugResult = await NodeUtils.debugImageDisplay(
              resultImage,
              outputFormat,
              outputQuality,
              node,
              true,
              debugWidth
            );

            if (debugResult) {
              debugFormat = debugResult.formatMessage;
              NodeUtils.setSuccessStatusWithDebug(
                node,
                1,
                elapsed,
                timing,
                debugFormat
              );
            }
          } catch (debugErr) {
            node.warn(`Debug display error: ${debugErr.message}`);
          }
        }

        if (!debugFormat) {
          NodeUtils.setSuccessStatus(node, 1, elapsed, timing);
        }

        NodeUtils.recordPerformanceMetrics(node, msg, timing || {}, elapsed);

        send(msg);
        done && done();
      } catch (err) {
        NodeUtils.handleNodeError(node, err, msg, done, 'draw processing');
      }
    });

    function resolvePoints(pointsConfig, msg) {
      const resolved = [];
      for (let i = 0; i < pointsConfig.length; i++) {
        const cfg = pointsConfig[i] || {};
        try {
          const x = resolveNormalizedNumber(cfg.xType, cfg.xValue, msg, `points[${i}].x`);
          const y = resolveNormalizedNumber(cfg.yType, cfg.yValue, msg, `points[${i}].y`);
          const radius = resolvePositiveNormalized(
            cfg.radiusType,
            cfg.radiusValue,
            msg,
            `points[${i}].radius`,
            0.01
          );
          const opacity = resolveOpacity(
            cfg.opacityType,
            cfg.opacityValue,
            msg,
            `points[${i}].opacity`,
            1
          );
          const color = resolveColor(
            cfg.colorType,
            cfg.colorValue,
            msg,
            `points[${i}].color`,
            '#ff0000'
          );

          resolved.push({
            x,
            y,
            radius,
            r: color.r,
            g: color.g,
            b: color.b,
            a: opacity * color.a
          });
        } catch (err) {
          node.warn(err.message);
        }
      }
      return resolved;
    }

    function resolveLines(linesConfig, msg) {
      const resolved = [];
      for (let i = 0; i < linesConfig.length; i++) {
        const cfg = linesConfig[i] || {};
        try {
          const x1 = resolveNormalizedNumber(cfg.x1Type, cfg.x1Value, msg, `lines[${i}].x1`);
          const y1 = resolveNormalizedNumber(cfg.y1Type, cfg.y1Value, msg, `lines[${i}].y1`);
          const x2 = resolveNormalizedNumber(cfg.x2Type, cfg.x2Value, msg, `lines[${i}].x2`);
          const y2 = resolveNormalizedNumber(cfg.y2Type, cfg.y2Value, msg, `lines[${i}].y2`);
          const thickness = resolvePositiveNormalized(
            cfg.thicknessType,
            cfg.thicknessValue,
            msg,
            `lines[${i}].thickness`,
            0.005
          );
          const opacity = resolveOpacity(
            cfg.opacityType,
            cfg.opacityValue,
            msg,
            `lines[${i}].opacity`,
            1
          );
          const color = resolveColor(
            cfg.colorType,
            cfg.colorValue,
            msg,
            `lines[${i}].color`,
            '#00ff00'
          );

          resolved.push({
            x1,
            y1,
            x2,
            y2,
            thickness,
            r: color.r,
            g: color.g,
            b: color.b,
            a: opacity * color.a
          });
        } catch (err) {
          node.warn(err.message);
        }
      }
      return resolved;
    }

    function resolveNormalizedNumber(type, value, msg, fieldLabel) {
      const num = resolveNumber(type, value, msg, fieldLabel, null);
      if (num < 0 || num > 1 || !Number.isFinite(num)) {
        throw new Error(`${fieldLabel} must be a number between 0 and 1`);
      }
      return num;
    }

    function resolvePositiveNormalized(type, value, msg, fieldLabel, fallback) {
      const num = resolveNumber(type, value, msg, fieldLabel, fallback);
      if (!Number.isFinite(num) || num < 0) {
        throw new Error(`${fieldLabel} must be a non-negative number`);
      }
      return Math.min(num, 1);
    }

    function resolveOpacity(type, value, msg, fieldLabel, fallback) {
      const num = resolveNumber(type, value, msg, fieldLabel, fallback);
      if (!Number.isFinite(num) || num < 0 || num > 1) {
        throw new Error(`${fieldLabel} must be within [0, 1]`);
      }
      return num;
    }

    function resolveNumber(type, value, msg, fieldLabel, fallback) {
      let resolved = null;
      const inputType = type || 'num';

      if (
        (value === undefined || value === null || value === '') &&
        (inputType === 'num' || inputType === 'str')
      ) {
        if (fallback !== null && fallback !== undefined) {
          return fallback;
        }
        throw new Error(`${fieldLabel} is required`);
      }

      if (inputType === 'msg' || inputType === 'flow' || inputType === 'global') {
        try {
          resolved = RED.util.evaluateNodeProperty(value, inputType, node, msg);
        } catch (err) {
          throw new Error(`${fieldLabel} resolution error: ${err.message}`);
        }
      } else {
        resolved = value;
      }

      const num = Number(resolved);
      if (!Number.isFinite(num)) {
        throw new Error(`${fieldLabel} must resolve to a number`);
      }
      return num;
    }

    function resolveColor(type, value, msg, fieldLabel, fallback) {
      let resolved = null;
      const inputType = type || 'str';

      if (
        (value === undefined || value === null || value === '') &&
        inputType === 'str'
      ) {
        resolved = fallback;
      } else if (inputType === 'msg' || inputType === 'flow' || inputType === 'global') {
        try {
          resolved = RED.util.evaluateNodeProperty(value, inputType, node, msg);
        } catch (err) {
          throw new Error(`${fieldLabel} resolution error: ${err.message}`);
        }
      } else {
        resolved = value;
      }

      if (typeof resolved !== 'string') {
        throw new Error(`${fieldLabel} must resolve to a string in #RRGGBB or #RRGGBBAA format`);
      }

      const colorString = resolved.trim();
      const match = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(colorString);
      if (!match) {
        throw new Error(`${fieldLabel} must be in #RRGGBB or #RRGGBBAA format`);
      }

      const hex = match[1];
      const alphaHex = match[2];
      return {
        r: parseInt(hex.substring(0, 2), 16),
        g: parseInt(hex.substring(2, 4), 16),
        b: parseInt(hex.substring(4, 6), 16),
        a: alphaHex ? parseInt(alphaHex, 16) / 255 : 1
      };
    }
  }

  RED.nodes.registerType('draw', DrawNode);
};
