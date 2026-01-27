/**
 * @file Node-RED logic for the image-align node (C++-driven ECC alignment).
 * Ultra-fast image alignment using OpenCV ECC algorithm.
 * @author Rosepetal
 */
const { performance } = require('perf_hooks');
const CppProcessor = require('../../lib/cpp-bridge.js');

module.exports = function (RED) {
  const NodeUtils = require('../../lib/node-utils.js')(RED);

  function ImageAlignNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.on('input', async (msg, send, done) => {
      // Capture images early for error passthrough
      const outputPath = config.outputPath || 'payload';
      const referenceImagePath = config.referenceImagePath || 'payload.reference';
      const targetImagePath = config.targetImagePath || 'payload.target';

      const { value: referenceImage, error: refErr } =
        NodeUtils.safeGetMessageProperty(msg, referenceImagePath);
      if (refErr) {
        return NodeUtils.handleValidationErrorWithPassthrough(
          node,
          {
            message: `Invalid referenceImagePath "${referenceImagePath}": ${refErr.message}`,
            hint: `Ensure "${referenceImagePath}" exists on msg and contains an image.`,
            details: { referenceImagePath, targetImagePath, outputPath }
          },
          msg,
          send,
          done,
          { originalPayload: undefined, outputPath: null, outputType: 'preserve' }
        );
      }

      const { value: targetImage, error: targetErr } =
        NodeUtils.safeGetMessageProperty(msg, targetImagePath);
      if (targetErr) {
        return NodeUtils.handleValidationErrorWithPassthrough(
          node,
          {
            message: `Invalid targetImagePath "${targetImagePath}": ${targetErr.message}`,
            hint: `Ensure "${targetImagePath}" exists on msg and contains an image.`,
            details: { referenceImagePath, targetImagePath, outputPath }
          },
          msg,
          send,
          done,
          { originalPayload: referenceImage, outputPath, outputType: 'single' }
        );
      }

      // For error passthrough: prefer target, fallback to reference, else undefined
      const passthroughImage = targetImage || referenceImage || undefined;

      try {
        const startTime = performance.now();
        node.status({});

        const outputFormat = config.outputFormat || 'raw';
        const outputQuality = parseInt(config.outputQuality) || 90;
        const pngOptimize = config.pngOptimize || false;
        const preset = config.preset || 'ultra-fast';
        const returnMatrix = config.returnMatrix || false;
        const transformPolygon = config.transformPolygon || false;

        /* ▸ Read images from message ------------------------------------ */
        // Validate input images
        const ref = NodeUtils.validateImageStructure(referenceImage, node);
        if (!ref) {
          return NodeUtils.handleValidationErrorWithPassthrough(
            node, 'Reference image is invalid or missing', msg, send, done,
            { originalPayload: passthroughImage, outputPath, outputType: 'single' }
          );
        }

        const target = NodeUtils.validateImageStructure(targetImage, node);
        if (!target) {
          return NodeUtils.handleValidationErrorWithPassthrough(
            node, 'Target image is invalid or missing', msg, send, done,
            { originalPayload: passthroughImage, outputPath, outputType: 'single' }
          );
        }

        // Read and validate polygon(s) if transform polygon is enabled
        let polygon = null;
        let isPolygonArray = false;
        if (transformPolygon) {
          const polygonPath = config.polygonPath || 'payload.polygon';
          const { value, error } = NodeUtils.safeGetMessageProperty(msg, polygonPath);
          if (error) {
            node.warn(`Invalid polygonPath "${polygonPath}": ${error.message} (polygon transform skipped)`);
            polygon = null;
          } else {
            polygon = value;
          }
          
          // Validate polygon coordinates
          if (polygon) {
            if (!Array.isArray(polygon)) {
              polygon = null;
            } else if (polygon.length === 0) {
              polygon = null;
            } else {
              // Check if this is a single polygon or array of polygons
              // Single polygon: [[x,y], [x,y], ...]
              // Array of polygons: [[[x,y], [x,y], ...], [[x,y], [x,y], ...], ...]
              const firstElement = polygon[0];
              if (Array.isArray(firstElement) && firstElement.length >= 2 && 
                  typeof firstElement[0] === 'number' && typeof firstElement[1] === 'number') {
                // Single polygon
                isPolygonArray = false;
                const validPolygon = validateSinglePolygon(polygon, node);
                if (!validPolygon) {
                  polygon = null;
                }
              } else if (Array.isArray(firstElement) && firstElement.length > 0 && 
                         Array.isArray(firstElement[0])) {
                // Array of polygons
                isPolygonArray = true;
                const validPolygons = [];
                let allValid = true;
                
                for (let i = 0; i < polygon.length; i++) {
                  const singlePolygon = polygon[i];
                  if (!Array.isArray(singlePolygon)) {
                    node.warn(`Invalid polygon at index ${i}: expected array of coordinate pairs`);
                    allValid = false;
                    break;
                  }
                  
                  if (validateSinglePolygon(singlePolygon, node, `polygon[${i}]`)) {
                    validPolygons.push(singlePolygon);
                  } else {
                    allValid = false;
                    break;
                  }
                }
                
                if (!allValid || validPolygons.length === 0) {
                  polygon = null;
                } else {
                  polygon = validPolygons;
                }
              } else {
                node.warn("Invalid polygon structure: expected [[x,y], ...] or [[[x,y], ...], ...]");
                polygon = null;
              }
            }
          }
        }
        
        // Helper function to validate a single polygon
        function validateSinglePolygon(poly, node, prefix = '') {
          if (!Array.isArray(poly) || poly.length === 0) {
            node.warn(`${prefix ? prefix + ': ' : ''}Polygon must be a non-empty array`);
            return false;
          }
          
          for (let i = 0; i < poly.length; i++) {
            const point = poly[i];
            if (!Array.isArray(point) || point.length !== 2) {
              node.warn(`${prefix ? prefix + ' ' : ''}Invalid coordinate at index ${i}: expected [x, y] pair`);
              return false;
            }
            
            const [x, y] = point;
            if (typeof x !== 'number' || typeof y !== 'number') {
              node.warn(`${prefix ? prefix + ' ' : ''}Invalid coordinate at index ${i}: coordinates must be numbers`);
              return false;
            }
            
            if (x < 0 || x > 1 || y < 0 || y > 1) {
              node.warn(`${prefix ? prefix + ' ' : ''}Invalid coordinate at index ${i}: coordinates must be in range [0, 1]`);
              return false;
            }
          }
          
          return true;
        }

        // Set alignment parameters based on preset
        let scale, maxIterations, terminationEps;
        if (preset === 'custom') {
          // Resolve custom parameters from msg/flow/global
          scale = NodeUtils.resolveDimension(
            node,
            config.customScaleType || 'num',
            config.customScale,
            msg
          );
          scale = parseFloat(scale) || 0.2;

          maxIterations = NodeUtils.resolveDimension(
            node,
            config.customMaxIterationsType || 'num',
            config.customMaxIterations,
            msg
          );
          maxIterations = parseInt(maxIterations) || 10;

          terminationEps = NodeUtils.resolveDimension(
            node,
            config.customTerminationEpsType || 'num',
            config.customTerminationEps,
            msg
          );
          terminationEps = parseFloat(terminationEps) || 1e-1;

          // Validate ranges
          scale = Math.max(0.1, Math.min(1.0, scale));
          maxIterations = Math.max(1, Math.min(200, maxIterations));
          terminationEps = Math.max(1e-6, Math.min(1e-1, terminationEps));
        } else {
          switch (preset) {
            case 'ultra-fast':
              scale = 0.2;
              maxIterations = 10;
              terminationEps = 1e-1;
              break;
            case 'fast':
              scale = 0.3;
              maxIterations = 20;
              terminationEps = 1e-2;
              break;
            case 'balanced':
              scale = 0.5;
              maxIterations = 30;
              terminationEps = 1e-3;
              break;
            case 'quality':
              scale = 0.7;
              maxIterations = 50;
              terminationEps = 1e-4;
              break;
            default:
              scale = 0.2;
              maxIterations = 10;
              terminationEps = 1e-1;
          }
        }

        /* ▸ Single call to the C++ addon --------------------------------- */
        const result = await CppProcessor.imageAlign(
          ref,
          target,
          scale,
          maxIterations,
          terminationEps,
          outputFormat,
          outputQuality,
          pngOptimize,
          returnMatrix,
          polygon
        );

        /* ▸ Status: standardized success formatting ----------------------- */
        const total = performance.now() - startTime;
        
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
              result.image, 
              outputFormat,
              outputQuality,
              node,
              debugEnabled,
              debugWidth
            );
            
            if (debugResult) {
              debugFormat = debugResult.formatMessage;
              // Update node status with debug info
              NodeUtils.setSuccessStatusWithDebug(node, 1, total, result.timing, debugFormat);
            }
          } catch (debugError) {
            node.warn(`Debug display error: ${debugError.message}`);
          }
        }
        
        // Set regular status if debug not enabled or failed
        if (!debugFormat) {
          NodeUtils.setSuccessStatus(node, 1, total, result.timing);
        }

        NodeUtils.recordPerformanceMetrics(node, msg, result.timing || {}, total);

        /* ▸ Write the result back to msg ---------------------------------- */
        RED.util.setMessageProperty(msg, outputPath, result.image);
        
        // Add alignment info to message
        msg.alignment = {
          success: result.success,
          timing: result.timing,
          preset: preset
        };
        
        // Add transformation matrix if returned
        if (result.transformMatrix) {
          msg.alignment.transformMatrix = result.transformMatrix;
        }
        
        // Add polygon data if polygon transformation was requested
        if (transformPolygon && polygon) {
          // Store original polygon(s)
          msg.alignment.originalPolygon = polygon;
          
          // Handle transformed polygon(s) based on input type
          if (result.transformedPolygon) {
            msg.alignment.transformedPolygon = result.transformedPolygon;
          } else if (result.transformedPolygons) {
            // For array of polygons
            msg.alignment.transformedPolygons = result.transformedPolygons;
          }
          
          // Store whether input was array for clarity
          msg.alignment.isPolygonArray = isPolygonArray;
        }

        send(msg);

        done && done();
      } catch (err) {
        NodeUtils.handleNodeErrorWithPassthrough(
          node, err, msg, send, done, 'image-align processing',
          {
            originalPayload: passthroughImage,
            outputPath,
            outputType: 'single',
            context: { referenceImagePath, targetImagePath, outputPath }
          }
        );
      }
    });
  }

  RED.nodes.registerType('image-align', ImageAlignNode);
};
