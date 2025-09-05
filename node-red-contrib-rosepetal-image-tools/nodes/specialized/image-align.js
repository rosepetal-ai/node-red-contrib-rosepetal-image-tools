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
      try {
        const startTime = performance.now();
        node.status({});
        
        const outputPath = config.outputPath || 'payload';
        const outputFormat = config.outputFormat || 'raw';
        const outputQuality = parseInt(config.outputQuality) || 90;
        const pngOptimize = config.pngOptimize || false;
        const preset = config.preset || 'ultra-fast';
        const returnMatrix = config.returnMatrix || false;
        const transformPolygon = config.transformPolygon || false;

        /* ▸ Read images from message ------------------------------------ */
        // Get images directly from specified paths
        const referenceImage = RED.util.getMessageProperty(msg, config.referenceImagePath || 'payload.reference');
        const targetImage = RED.util.getMessageProperty(msg, config.targetImagePath || 'payload.target');

        // Validate input images
        const ref = NodeUtils.validateImageStructure(referenceImage, node);
        if (!ref) {
          node.warn("Reference image is invalid or missing");
          return;
        }

        const target = NodeUtils.validateImageStructure(targetImage, node);
        if (!target) {
          node.warn("Target image is invalid or missing");
          return;
        }

        // Read and validate polygon if transform polygon is enabled
        let polygon = null;
        if (transformPolygon) {
          polygon = RED.util.getMessageProperty(msg, config.polygonPath || 'payload.polygon');
          
          // Validate polygon coordinates
          if (polygon) {
            if (!Array.isArray(polygon)) {
              node.warn("Polygon coordinates must be an array");
              polygon = null;
            } else if (polygon.length === 0) {
              node.warn("Polygon coordinates array is empty");
              polygon = null;
            } else {
              // Validate each coordinate pair
              let validPolygon = true;
              for (let i = 0; i < polygon.length; i++) {
                const point = polygon[i];
                if (!Array.isArray(point) || point.length !== 2) {
                  node.warn(`Invalid polygon coordinate at index ${i}: expected [x, y] pair`);
                  validPolygon = false;
                  break;
                }
                
                const [x, y] = point;
                if (typeof x !== 'number' || typeof y !== 'number') {
                  node.warn(`Invalid polygon coordinate at index ${i}: coordinates must be numbers`);
                  validPolygon = false;
                  break;
                }
                
                if (x < 0 || x > 1 || y < 0 || y > 1) {
                  node.warn(`Invalid polygon coordinate at index ${i}: coordinates must be in range [0, 1]`);
                  validPolygon = false;
                  break;
                }
              }
              
              if (!validPolygon) {
                polygon = null;
              }
            }
          }
        }

        // Set alignment parameters based on preset
        let scale, maxIterations, terminationEps;
        if (preset === 'custom') {
          // Use custom parameters from configuration
          scale = parseFloat(config.customScale) || 0.2;
          maxIterations = parseInt(config.customMaxIterations) || 10;
          terminationEps = parseFloat(config.customTerminationEps) || 1e-1;
          
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
        if (config.debugEnabled) {
          try {
            // Resolve and validate debug width
            let debugWidth = NodeUtils.resolveDimension(
              node,
              config.debugWidthType,
              config.debugWidth,
              msg
            );
            debugWidth = Math.max(1, parseInt(debugWidth) || 200); // Ensure positive, default 200
            
            const debugResult = await NodeUtils.debugImageDisplay(
              result.image, 
              outputFormat,
              outputQuality,
              node,
              true,
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
          msg.alignment.originalPolygon = polygon;
          if (result.transformedPolygon) {
            msg.alignment.transformedPolygon = result.transformedPolygon;
          }
        }

        send(msg);
        
        done && done();
      } catch (err) {
        NodeUtils.handleNodeError(node, err, msg, done, 'image alignment');
      }
    });
  }

  RED.nodes.registerType('image-align', ImageAlignNode);
};