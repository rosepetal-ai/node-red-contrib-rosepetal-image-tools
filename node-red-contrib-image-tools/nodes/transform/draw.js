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
      const inputPath = config.inputPath || 'payload';
      const inputPathType = config.inputPathType || 'msg';
      const outputPath = config.outputPath || 'payload';
      const outputPathType = config.outputPathType || 'msg';
      const { value: originalPayload, error: inputErr } =
        NodeUtils.getInputValue(node, msg, inputPath, inputPathType);
      if (inputErr) {
        const hint = inputPathType === 'msg'
          ? `Set inputPath to an existing msg property (e.g. "payload"), or ensure "${inputPath}" exists before this node.`
          : `Set inputPath to an existing ${inputPathType} context key, or ensure "${inputPath}" exists before this node.`;
        return NodeUtils.handleValidationErrorWithPassthrough(
          node,
          {
            message: `Invalid inputPath "${inputPath}" (${inputPathType}): ${inputErr.message}`,
            hint,
            details: { inputPath, inputPathType, outputPath, outputPathType }
          },
          msg,
          send,
          done,
          { originalPayload: undefined, outputPath: null, outputPathType, outputType: 'preserve' }
        );
      }

      try {
        const startTime = performance.now();
        node.status({});

        const outputFormat = config.outputFormat || 'raw';
        const outputQuality = parseInt(config.outputQuality, 10) || 90;
        const pngOptimize = config.pngOptimize || false;
        const useSharpWebp = outputFormat === 'webp' && NodeUtils.hasAdvancedWebpOptions(config);
        const cppFormat = useSharpWebp ? 'raw' : outputFormat;

        const baseImage = NodeUtils.validateImageStructure(originalPayload, node);
        if (!baseImage) {
          return NodeUtils.handleValidationErrorWithPassthrough(
            node, 'Invalid image structure', msg, send, done,
            { originalPayload, outputPath, outputPathType, outputType: 'preserve' }
          );
        }

        const resolvedPoints = resolvePoints(config.points || [], msg);
        const resolvedLines = resolveLines(config.lines || [], msg);

        if (!resolvedPoints.length && !resolvedLines.length) {
          node.warn('No valid points or lines configured. Outputting original image.');
        }

        let { image: resultImage, timing = {} } = await CppProcessor.draw(
          baseImage,
          resolvedPoints,
          resolvedLines,
          cppFormat,
          outputQuality,
          pngOptimize
        );

        if (useSharpWebp) {
          resultImage = await NodeUtils.encodeWebpAdvanced(resultImage, config);
        }

        NodeUtils.setOutputValue(node, msg, outputPath, outputPathType, resultImage);

        const elapsed = performance.now() - startTime;
        let debugFormat = null;

        const debugEnabled = config.debugEnabled === true || config.debugEnabled === 'true';
        if (debugEnabled) {
          try {
            let debugWidth = NodeUtils.resolveDimension(
              node,
              config.debugWidthType || 'num',
              config.debugWidth,
              msg
            );
            debugWidth = Math.max(1, parseInt(debugWidth, 10) || 200);

            const debugResult = await NodeUtils.debugImageDisplay(
              resultImage,
              outputFormat,
              outputQuality,
              node,
              debugEnabled,
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
        NodeUtils.handleNodeErrorWithPassthrough(
          node, err, msg, send, done, 'draw processing',
          { originalPayload, outputPath, outputPathType, outputType: 'preserve' }
        );
      }
    });

    function resolvePoints(pointsConfig, msg) {
      const resolved = [];
      for (let i = 0; i < pointsConfig.length; i++) {
        const cfg = pointsConfig[i] || {};
        try {
          if (cfg.mode === 'list') {
            const list = resolveList(
              cfg.listType,
              cfg.listValue,
              msg,
              `points[${i}].list`,
              2
            );

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

            let added = 0;
            for (let idx = 0; idx < list.length; idx++) {
              const entry = list[idx];
              try {
                const [xVal, yVal] = resolveListNumbers(
                  entry,
                  2,
                  `points[${i}].list[${idx}]`
                );
                const x = resolveNormalizedRawNumber(xVal, `points[${i}].list[${idx}].x`);
                const y = resolveNormalizedRawNumber(yVal, `points[${i}].list[${idx}].y`);

                resolved.push({
                  x,
                  y,
                  radius,
                  r: color.r,
                  g: color.g,
                  b: color.b,
                  a: opacity * color.a
                });
                added++;
              } catch (err) {
                node.warn(err.message);
              }
            }

            // if (!added) {
            //   node.warn(`points[${i}] list contains no valid entries`);
            // }
            continue;
          }

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
          if (cfg.mode === 'list') {
            const list = resolveList(
              cfg.listType,
              cfg.listValue,
              msg,
              `lines[${i}].list`,
              4
            );

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

            let added = 0;
            for (let idx = 0; idx < list.length; idx++) {
              const entry = list[idx];
              try {
                const [x1Val, y1Val, x2Val, y2Val] = resolveListNumbers(
                  entry,
                  4,
                  `lines[${i}].list[${idx}]`
                );

                const x1 = resolveNormalizedRawNumber(
                  x1Val,
                  `lines[${i}].list[${idx}].x1`
                );
                const y1 = resolveNormalizedRawNumber(
                  y1Val,
                  `lines[${i}].list[${idx}].y1`
                );
                const x2 = resolveNormalizedRawNumber(
                  x2Val,
                  `lines[${i}].list[${idx}].x2`
                );
                const y2 = resolveNormalizedRawNumber(
                  y2Val,
                  `lines[${i}].list[${idx}].y2`
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
                added++;
              } catch (err) {
                node.warn(err.message);
              }
            }

            // if (!added) {
            //   node.warn(`lines[${i}] list contains no valid entries`);
            // }
            continue;
          }

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

    function resolveNormalizedRawNumber(value, fieldLabel) {
      const num = Number(value);
      if (!Number.isFinite(num) || num < 0 || num > 1) {
        throw new Error(`${fieldLabel} must be a number between 0 and 1`);
      }
      return num;
    }

    function resolveList(type, value, msg, fieldLabel, expectedLength) {
      const inputType = type || 'json';
      let resolved = value;

      if (
        (value === undefined || value === null || value === '') &&
        (inputType === 'json' || inputType === 'str')
      ) {
        throw new Error(`${fieldLabel} list is required`);
      }

      if (inputType === 'msg' || inputType === 'flow' || inputType === 'global') {
        try {
          resolved = RED.util.evaluateNodeProperty(value, inputType, node, msg);
        } catch (err) {
          throw new Error(`${fieldLabel} resolution error: ${err.message}`);
        }
      }

      if (typeof resolved === 'string') {
        try {
          resolved = JSON.parse(resolved);
        } catch (err) {
          throw new Error(`${fieldLabel} must be valid JSON array: ${err.message}`);
        }
      }

      if (!Array.isArray(resolved)) {
        const expectedMsg = expectedLength ? ` of length-${expectedLength} entries` : '';
        throw new Error(`${fieldLabel} must resolve to an array${expectedMsg}`);
      }

      if (resolved.length === 0) {
        const expectedMsg = expectedLength ? ` (each item length ${expectedLength})` : '';
        //throw new Error(`${fieldLabel} array is empty${expectedMsg}`);
      }

      return resolved;
    }

    function resolveListNumbers(entry, expectedLength, fieldLabel) {
      if (!Array.isArray(entry)) {
        throw new Error(`${fieldLabel} must be an array`);
      }
      if (entry.length < expectedLength) {
        throw new Error(`${fieldLabel} must have at least ${expectedLength} numbers`);
      }

      const values = entry.slice(0, expectedLength).map((v, idx) => {
        const num = Number(v);
        if (!Number.isFinite(num)) {
          throw new Error(`${fieldLabel}[${idx}] must be a number`);
        }
        return num;
      });

      return values;
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

  RED.nodes.registerType('rp-draw', DrawNode);
};
