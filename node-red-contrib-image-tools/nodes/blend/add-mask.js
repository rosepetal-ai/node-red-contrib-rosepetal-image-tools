/**
 * Node‑RED logic for *rosepetal‑add‑mask* (C++ backend).
 * Applies a polygon-based mask to a base image using weighted blending with
 * configurable mask strength and colors.
 *
 * Timing fields returned by C++:
 *   timing.convertMs · timing.taskMs · timing.encodeMs
 * …and the node status shows: OK … (conv X | task Y ms)
 */
const { performance } = require('perf_hooks');
const Cpp             = require('../../lib/cpp-bridge.js');

module.exports = function (RED) {
  const NodeUtils = require('../../lib/node-utils.js')(RED);

  function AddMaskNode (config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.on('input', async (msg, send, done) => {
      // Capture original payload for error passthrough
      const outputPath = config.outputPath || 'payload';
      const { value: originalPayload, error: outErr } =
        NodeUtils.safeGetMessageProperty(msg, outputPath);
      if (outErr) {
        // Don't crash on invalid outputPath; just report it and continue without passthrough output set.
        return NodeUtils.handleValidationErrorWithPassthrough(
          node,
          {
            message: `Invalid outputPath "${outputPath}": ${outErr.message}`,
            hint: `Set outputPath to a valid msg property path (e.g. "payload").`,
            details: { outputPath }
          },
          msg,
          send,
          done,
          { originalPayload: undefined, outputPath: null, outputType: 'preserve' }
        );
      }

      try {
        const t0 = performance.now();
        node.status({});                                      // clear status

        /* ▸ Read image and polygon from message -------------------------- */
        // Get base image and polygon coordinates from specified paths
        const imagePath = config.imagePath || 'payload.image';
        const polygonPath = config.polygonPath || 'payload.default.masks[0].mask[0]';

        const { value: image, error: imageErr } =
          NodeUtils.safeGetMessageProperty(msg, imagePath);
        if (imageErr) {
          return NodeUtils.handleValidationErrorWithPassthrough(
            node,
            {
              message: `Invalid imagePath "${imagePath}": ${imageErr.message}`,
              hint: `Ensure "${imagePath}" exists on msg and contains an image.`,
              details: { imagePath, polygonPath, outputPath }
            },
            msg,
            send,
            done,
            { originalPayload, outputPath, outputType: 'single' }
          );
        }

        const { value: polygon, error: polygonErr } =
          NodeUtils.safeGetMessageProperty(msg, polygonPath);
        if (polygonErr) {
          return NodeUtils.handleValidationErrorWithPassthrough(
            node,
            {
              message: `Invalid polygonPath "${polygonPath}": ${polygonErr.message}`,
              hint: `Ensure "${polygonPath}" exists on msg and contains polygon coordinates like [[x,y], ...] with values 0..1.`,
              details: { imagePath, polygonPath, outputPath }
            },
            msg,
            send,
            done,
            { originalPayload, outputPath, outputType: 'single' }
          );
        }

        // Validate base image
        const baseImg = NodeUtils.validateImageStructure(image, node);
        if (!baseImg) {
          return NodeUtils.handleValidationErrorWithPassthrough(
            node,
            {
              message: 'Base image is invalid or missing',
              hint: `Check that "${imagePath}" contains a valid image (Buffer or raw image object).`,
              details: { imagePath, polygonPath, outputPath }
            },
            msg,
            send,
            done,
            { originalPayload, outputPath, outputType: 'single' }
          );
        }

        // Validate polygon coordinates
        if (!Array.isArray(polygon)) {
          return NodeUtils.handleValidationErrorWithPassthrough(
            node,
            {
              message: 'Polygon coordinates must be an array',
              hint: `Set "${polygonPath}" to an array like [[x,y], ...] where x/y are numbers in range 0..1.`,
              details: { polygonPath, outputPath }
            },
            msg,
            send,
            done,
            { originalPayload, outputPath, outputType: 'single' }
          );
        }

        if (polygon.length === 0) {
          return NodeUtils.handleValidationErrorWithPassthrough(
            node, 'Polygon coordinates array is empty', msg, send, done,
            { originalPayload, outputPath, outputType: 'single' }
          );
        }

        // Validate polygon coordinate format
        for (let i = 0; i < polygon.length; i++) {
          const point = polygon[i];
          if (!Array.isArray(point) || point.length !== 2) {
            return NodeUtils.handleValidationErrorWithPassthrough(
              node, `Invalid polygon coordinate at index ${i}: expected [x, y] pair`, msg, send, done,
              { originalPayload, outputPath, outputType: 'single' }
            );
          }

          const [x, y] = point;
          if (typeof x !== 'number' || typeof y !== 'number') {
            return NodeUtils.handleValidationErrorWithPassthrough(
              node, `Invalid polygon coordinate at index ${i}: coordinates must be numbers`, msg, send, done,
              { originalPayload, outputPath, outputType: 'single' }
            );
          }

          if (x < 0 || x > 1 || y < 0 || y > 1) {
            return NodeUtils.handleValidationErrorWithPassthrough(
              node, `Invalid polygon coordinate at index ${i}: coordinates must be in range [0, 1]`, msg, send, done,
              { originalPayload, outputPath, outputType: 'single' }
            );
          }
        }

        /* ▸ Options from the editor -------------------------------------- */
        const maskStrength = Math.max(0, Math.min(100, parseInt(config.maskStrength) || 50)) / 100.0;
        const outputFormat = config.outputFormat || 'raw';
        const outputQuality = parseInt(config.outputQuality) || 90;
        const pngOptimize = config.pngOptimize || false;
        const useSharpWebp = outputFormat === 'webp' && NodeUtils.hasAdvancedWebpOptions(config);
        const cppFormat = useSharpWebp ? 'raw' : outputFormat;

        // Color processing
        const fillColor = config.fillColor || '#ffffff';
        
        // Convert hex color to RGB values
        let fillR = 255, fillG = 255, fillB = 255; // Default white
        if (fillColor.startsWith('#') && fillColor.length === 7) {
          fillR = parseInt(fillColor.substr(1, 2), 16);
          fillG = parseInt(fillColor.substr(3, 2), 16);
          fillB = parseInt(fillColor.substr(5, 2), 16);
        }

        /* ▸ Single call to the C++ addon --------------------------------- */
        let { image: result, timing = {} } =
              await Cpp.addMask(
                baseImg,
                polygon,
                maskStrength,
                fillR, fillG, fillB,
                cppFormat,
                outputQuality,
                pngOptimize
              );

        if (useSharpWebp) {
          result = await NodeUtils.encodeWebpAdvanced(result, config);
        }

        /* ▸ Write the result back to msg ---------------------------------- */
        RED.util.setMessageProperty(msg, config.outputPath || 'payload', result);

        /* ▸ Status: standardized success formatting ----------------------- */
        const total = performance.now() - t0;
        
        // Debug image display
        let debugFormat = null;
        const debugEnabled = config.debugEnabled === true || config.debugEnabled === 'true';
        if (debugEnabled) {
          try {
            // Resolve and validate debug width
            let debugWidth = NodeUtils.resolveDimension(
              node,
              config.debugWidthType || 'num',
              config.debugWidth,
              msg
            );
            debugWidth = Math.max(1, parseInt(debugWidth) || 200); // Ensure positive, default 200
            
            const debugResult = await NodeUtils.debugImageDisplay(
              result, 
              outputFormat,
              outputQuality,
              node,
              debugEnabled,
              debugWidth
            );
            
            if (debugResult) {
              debugFormat = debugResult.formatMessage;
              // Update node status with debug info
              NodeUtils.setSuccessStatusWithDebug(node, 1, total, timing, debugFormat);
            }
          } catch (debugError) {
            node.warn(`Debug display error: ${debugError.message}`);
          }
        }
        
        // Set regular status if debug not enabled or failed
        if (!debugFormat) {
          NodeUtils.setSuccessStatus(node, 1, total, timing);
        }

        NodeUtils.recordPerformanceMetrics(node, msg, timing || {}, total);

        send(msg);
        done && done();
      } catch (err) {
        NodeUtils.handleNodeErrorWithPassthrough(
          node, err, msg, send, done, 'add-mask processing',
          {
            originalPayload,
            outputPath,
            outputType: 'single',
            context: { outputPath }
          }
        );
      }
    });
  }

  RED.nodes.registerType('add-mask', AddMaskNode);
};
