/**
 * @file Node-RED logic for the image-align node (C++-driven ECC alignment).
 * Ultra-fast image alignment using OpenCV ECC algorithm.
 * Accepts two single images or two same-length arrays (paired by index).
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
        const useSharpWebp = outputFormat === 'webp' && NodeUtils.hasAdvancedWebpOptions(config);
        const cppFormat = useSharpWebp ? 'raw' : outputFormat;
        const preset = config.preset || 'ultra-fast';
        const returnMatrix = config.returnMatrix || false;
        const transformPolygon = config.transformPolygon || false;

        // Default to 'translation' so existing flows that were saved before
        // motionModel was added behave bit-identically. New nodes set
        // motionModel = 'affine' via the HTML defaults.
        const motionModel = config.motionModel || 'translation';
        const VALID_MOTION_MODELS = ['translation', 'euclidean', 'affine', 'homography'];
        if (!VALID_MOTION_MODELS.includes(motionModel)) {
          return NodeUtils.handleValidationErrorWithPassthrough(
            node,
            {
              message: `Invalid motionModel "${motionModel}"`,
              hint: `motionModel must be one of: ${VALID_MOTION_MODELS.join(', ')}`,
              details: { motionModel, referenceImagePath, targetImagePath, outputPath }
            },
            msg, send, done,
            { originalPayload: passthroughImage, outputPath, outputType: 'single' }
          );
        }

        // Pipeline: which alignment algorithm(s) to run.
        //   ecc           - intensity-based ECC only (legacy default)
        //   features      - ORB+RANSAC only, no ECC refinement
        //   features+ecc  - ORB seed -> ECC refinement (best accuracy)
        // Default 'ecc' for back-compat with flows saved before this field existed;
        // new nodes get 'features+ecc' via the HTML defaults block.
        const pipeline = config.pipeline || 'ecc';
        const VALID_PIPELINES = ['ecc', 'features', 'features+ecc'];
        if (!VALID_PIPELINES.includes(pipeline)) {
          return NodeUtils.handleValidationErrorWithPassthrough(
            node,
            {
              message: `Invalid pipeline "${pipeline}"`,
              hint: `pipeline must be one of: ${VALID_PIPELINES.join(', ')}`,
              details: { pipeline, referenceImagePath, targetImagePath, outputPath }
            },
            msg, send, done,
            { originalPayload: passthroughImage, outputPath, outputType: 'single' }
          );
        }

        // ECC refinement policy. Only meaningful when pipeline === 'features+ecc'.
        //   always - run ECC refinement on every call (legacy default)
        //   auto   - skip ECC when ORB seed has high RANSAC inlier count (>=50);
        //            saves ~10-75% time on clean feature-rich data with ~5%
        //            accuracy loss in edge cases
        //   never  - never run ECC; equivalent to pipeline=features but keeps
        //            the features+ecc mode in saved config for easy toggling
        // Default 'always' for back-compat. New nodes also default to 'always'
        // unless the user explicitly opts in via the dropdown.
        const eccRefine = config.eccRefine || 'always';
        const VALID_ECC_REFINE = ['always', 'auto', 'never'];
        if (!VALID_ECC_REFINE.includes(eccRefine)) {
          return NodeUtils.handleValidationErrorWithPassthrough(
            node,
            {
              message: `Invalid eccRefine "${eccRefine}"`,
              hint: `eccRefine must be one of: ${VALID_ECC_REFINE.join(', ')}`,
              details: { eccRefine, referenceImagePath, targetImagePath, outputPath }
            },
            msg, send, done,
            { originalPayload: passthroughImage, outputPath, outputType: 'single' }
          );
        }

        // Feature detector for the seed stage (pipelines features / features+ecc).
        //   orb  - binary descriptors, fastest (default)
        //   sift - float descriptors, more robust on low-texture/blurry images
        const detector = config.detector || 'orb';
        const VALID_DETECTORS = ['orb', 'sift'];
        if (!VALID_DETECTORS.includes(detector)) {
          return NodeUtils.handleValidationErrorWithPassthrough(
            node,
            {
              message: `Invalid detector "${detector}"`,
              hint: `detector must be one of: ${VALID_DETECTORS.join(', ')}`,
              details: { detector, referenceImagePath, targetImagePath, outputPath }
            },
            msg, send, done,
            { originalPayload: passthroughImage, outputPath, outputType: 'single' }
          );
        }

        /* ▸ Read images from message ------------------------------------ */
        // Both inputs must have the same shape: two singles, or two same-length arrays
        const isArray = Array.isArray(referenceImage);
        if (isArray !== Array.isArray(targetImage)) {
          return NodeUtils.handleValidationErrorWithPassthrough(
            node,
            {
              message: 'Reference and target must both be single images or both be arrays',
              hint: `"${referenceImagePath}" is ${isArray ? 'an array' : 'a single image'} but "${targetImagePath}" is not.`,
              details: { referenceImagePath, targetImagePath, outputPath }
            },
            msg, send, done,
            { originalPayload: passthroughImage, outputPath, outputType: 'single' }
          );
        }
        if (isArray && (referenceImage.length === 0 || referenceImage.length !== targetImage.length)) {
          return NodeUtils.handleValidationErrorWithPassthrough(
            node,
            {
              message: `Image arrays must be non-empty and of equal length (got ${referenceImage.length} and ${targetImage.length})`,
              hint: 'Images are paired by index; both arrays must contain the same number of images.',
              details: { referenceImagePath, targetImagePath, outputPath }
            },
            msg, send, done,
            { originalPayload: passthroughImage, outputPath, outputType: 'single' }
          );
        }

        const refList = (isArray ? referenceImage : [referenceImage])
          .map(img => NodeUtils.validateImageStructure(img, node));
        if (refList.some(img => !img)) {
          return NodeUtils.handleValidationErrorWithPassthrough(
            node, 'Reference image is invalid or missing', msg, send, done,
            { originalPayload: passthroughImage, outputPath, outputType: 'single' }
          );
        }

        const targetList = (isArray ? targetImage : [targetImage])
          .map(img => NodeUtils.validateImageStructure(img, node));
        if (targetList.some(img => !img)) {
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

        /* ▸ One C++ call per pair (index-matched) ------------------------- */
        const results = await Promise.all(
          refList.map((refImg, i) =>
            CppProcessor.imageAlign(
              refImg,
              targetList[i],
              scale,
              maxIterations,
              terminationEps,
              cppFormat,
              outputQuality,
              pngOptimize,
              returnMatrix,
              polygon,
              motionModel,
              pipeline,
              eccRefine,
              detector
            ))
        );

        // Aggregate timings across pairs
        const timing = results.reduce(
          (acc, { timing: t }) => {
            acc.convertMs += t?.convertMs ?? 0;
            acc.taskMs    += t?.taskMs    ?? 0;
            acc.encodeMs  += t?.encodeMs  ?? 0;
            return acc;
          },
          { convertMs: 0, taskMs: 0, encodeMs: 0 }
        );
        const images = results.map(r => r.image);

        if (useSharpWebp) {
          // Encode all images concurrently (Sharp runs on the libuv thread pool)
          const webps = await Promise.all(images.map((img) => NodeUtils.encodeWebpAdvanced(img, config)));
          webps.forEach((webp, i) => { images[i] = webp; });
        }

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

            // For arrays, show the first aligned image as representative
            const debugResult = await NodeUtils.debugImageDisplay(
              images[0],
              outputFormat,
              outputQuality,
              node,
              debugEnabled,
              debugWidth
            );

            if (debugResult) {
              debugFormat = debugResult.formatMessage;
              // Update node status with debug info
              NodeUtils.setSuccessStatusWithDebug(node, results.length, total, timing,
                debugFormat + (isArray ? ' (first)' : ''));
            }
          } catch (debugError) {
            node.warn(`Debug display error: ${debugError.message}`);
          }
        }

        // Set regular status if debug not enabled or failed
        if (!debugFormat) {
          NodeUtils.setSuccessStatus(node, results.length, total, timing);
        }

        NodeUtils.recordPerformanceMetrics(node, msg, timing, total);

        /* ▸ Write the result back to msg (array in, array out) ------------ */
        RED.util.setMessageProperty(msg, outputPath, isArray ? images : images[0]);
        
        // Add alignment info to message; per-pair fields follow the output
        // shape (single in -> single out, array in -> array out)
        msg.alignment = {
          success: isArray ? results.every(r => r.success) : results[0].success,
          timing: timing,
          preset: preset,
          motionModel: motionModel,
          pipeline: pipeline,
          eccRefine: eccRefine,
          detector: detector
        };

        // Add transformation matrix if returned
        const matrices = results.map(r => r.transformMatrix);
        if (matrices.some(Boolean)) {
          msg.alignment.transformMatrix = isArray ? matrices : matrices[0];
        }

        // Add polygon data if polygon transformation was requested
        if (transformPolygon && polygon) {
          // Store original polygon(s); the same polygon(s) are transformed
          // per pair, each with that pair's matrix
          msg.alignment.originalPolygon = polygon;

          const transformed = results.map(r => r.transformedPolygon ?? r.transformedPolygons ?? null);
          if (transformed.some(Boolean)) {
            const key = isPolygonArray ? 'transformedPolygons' : 'transformedPolygon';
            msg.alignment[key] = isArray ? transformed : transformed[0];
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

  RED.nodes.registerType('rp-image-align', ImageAlignNode);
};
