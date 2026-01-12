/**
 * Node-RED logic for cropBB (Crop Bounding Boxes)
 * Extracts image crops from bounding box detection results
 * @author Rosepetal
 */
const { performance } = require('perf_hooks');
const CppProcessor = require('../../lib/cpp-bridge.js');

module.exports = function (RED) {
  const NodeUtils = require('../../lib/node-utils.js')(RED);

  function CropBBNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.on('input', async (msg, send, done) => {
      /* Output path - captured early for error passthrough */
      const outputPath = config.outputPath || 'payload';

      try {
        const t0 = performance.now();
        node.status({});

        /* Input/Output paths */
        const imageInputPath = config.imageInputPath || 'images';
        const bboxInputPath = config.bboxInputPath || 'default';

        /* Configuration */
        const outputFormat = config.outputFormat || 'raw';
        const outputQuality = parseInt(config.outputQuality) || 90;
        const pngOptimize = config.pngOptimize || false;
        const minConfidence = NodeUtils.resolveDimension(node, config.minConfidenceType, config.minConfidence, msg) || 0.5;

        /* Get input data */
        const imageData = RED.util.getMessageProperty(msg, imageInputPath);
        const bboxData = RED.util.getMessageProperty(msg, bboxInputPath);

        if (!imageData) {
          return NodeUtils.handleValidationErrorWithPassthrough(
            node, `No image data found at ${imageInputPath}`, msg, send, done,
            { originalPayload: [], outputPath, outputType: 'empty-array' }
          );
        }

        if (!bboxData) {
          return NodeUtils.handleValidationErrorWithPassthrough(
            node, `No bounding box data found at ${bboxInputPath}`, msg, send, done,
            { originalPayload: [], outputPath, outputType: 'empty-array' }
          );
        }

        /* Handle single image vs array */
        const images = Array.isArray(imageData) ? imageData : [imageData];
        
        // The bboxData should be an array of detection objects
        if (!bboxData || !Array.isArray(bboxData)) {
          return NodeUtils.handleValidationErrorWithPassthrough(
            node, `Invalid bounding box data structure. Expected array at ${bboxInputPath}`, msg, send, done,
            { originalPayload: [], outputPath, outputType: 'empty-array' }
          );
        }
        
        const detections = bboxData;

        // Validate input images
        if (Array.isArray(imageData)) {
          if (!NodeUtils.validateListImage(imageData, node)) {
            return NodeUtils.handleValidationErrorWithPassthrough(
              node, 'Invalid image list structure', msg, send, done,
              { originalPayload: [], outputPath, outputType: 'empty-array' }
            );
          }
        } else {
          if (!NodeUtils.validateSingleImage(imageData, node)) {
            return NodeUtils.handleValidationErrorWithPassthrough(
              node, 'Invalid image structure', msg, send, done,
              { originalPayload: [], outputPath, outputType: 'empty-array' }
            );
          }
        }

        /* Process each image with the detections */
        const allCrops = [];
        let totalConvertMs = 0, totalTaskMs = 0, totalEncodeMs = 0;

        // For now, assume single image with all detections
        // In the future, could handle multiple images with detection arrays
        const image = images[0]; // Use first image
        
        /* Filter detections by confidence and extract bounding boxes */
        const validBboxes = [];
        for (const detection of detections) {
          const bbox = parseSingleDetection(detection, minConfidence, image, node);
          if (bbox) {
            validBboxes.push(bbox);
          }
        }
        
        if (validBboxes.length === 0) {
          node.warn(`No valid bounding boxes found with confidence >= ${minConfidence}`);
          RED.util.setMessageProperty(msg, outputPath, []);
          const elapsed = performance.now() - t0;
          NodeUtils.recordPerformanceMetrics(node, msg, {
            convertMs: 0,
            encodeMs: 0,
            taskMs: 0
          }, elapsed);
          send(msg);
          if (done) done();
          return;
        }

        /* Create crop jobs for all valid bounding boxes */
        const cropJobs = validBboxes.map(bbox => {
          // Convert bbox coordinates to crop parameters
          const { x, y, width, height, label, confidence, originalBbox } = bbox;

          return CppProcessor.crop(image, x, y, width, height, false, outputFormat, outputQuality, pngOptimize)
            .then(result => ({
              ...result.image,           // Spread image properties (data, width, height, channels, colorSpace, dtype)
              tag: label,                // Add tag metadata directly
              confidence: confidence,    // Add confidence metadata directly
              bbox: originalBbox,        // Add bbox metadata directly
              timing: result.timing
            }));
        });

        /* Execute all crops in parallel */
        const cropResults = await Promise.all(cropJobs);

        /* Accumulate results and timing */
        cropResults.forEach(result => {
          // Extract timing before pushing to output
          totalConvertMs += result.timing?.convertMs ?? 0;
          totalTaskMs += result.timing?.taskMs ?? 0;
          totalEncodeMs += result.timing?.encodeMs ?? 0;

          // Remove timing property and push flattened image with metadata
          const { timing, ...cropWithMetadata } = result;
          allCrops.push(cropWithMetadata);
        });

        /* Set output */
        RED.util.setMessageProperty(msg, outputPath, allCrops);

        /* Status and timing */
        const totalTime = performance.now() - t0;
        
        // Debug image display for first crop if enabled
        let debugFormat = null;
        if (config.debugEnabled && allCrops.length > 0) {
          try {
            let debugWidth = NodeUtils.resolveDimension(node, config.debugWidthType, config.debugWidth, msg) || 200;
            debugWidth = Math.max(1, parseInt(debugWidth));

            const debugResult = await NodeUtils.debugImageDisplay(
              allCrops[0],       // First crop is now directly the image object
              outputFormat,
              outputQuality,
              node,
              true,
              debugWidth
            );

            if (debugResult) {
              debugFormat = `${debugResult.formatMessage} (${debugResult.size}B)`;
            }
          } catch (debugError) {
            node.warn(`Debug display error: ${debugError.message}`);
          }
        }

        NodeUtils.setSuccessStatusWithDebug(
          node, 
          allCrops.length, 
          totalTime, 
          { convertMs: totalConvertMs, taskMs: totalTaskMs, encodeMs: totalEncodeMs },
          debugFormat
        );

        NodeUtils.recordPerformanceMetrics(node, msg, {
          convertMs: totalConvertMs,
          encodeMs: totalEncodeMs,
          taskMs: totalTaskMs
        }, totalTime);

        send(msg);
        if (done) done();
        
      } catch (err) {
        NodeUtils.handleNodeErrorWithPassthrough(
          node, err, msg, send, done, 'cropBB processing',
          { originalPayload: [], outputPath, outputType: 'empty-array' }
        );
      }
    });
  }

  /**
   * Parse a single detection object into standardized bbox format
   * Handles the format:
   * {
   *   "raw_boxes": [[x1,y1], [x2,y1], [x2,y2], [x1,y2]], // normalized 0-1 coordinates
   *   "confidence": 0.97,
   *   "tag": "mountain"
   * }
   */
  function parseSingleDetection(det, minConfidence, image, node) {
    if (!det || typeof det !== 'object') return null;

    // Extract confidence
    const confidence = det.confidence || 1.0;
    if (confidence < minConfidence) return null;

    // Extract tag
    const label = det.tag || 'unknown';

    // Extract coordinates from 4-corner format
    if (!det.raw_boxes || !Array.isArray(det.raw_boxes) || det.raw_boxes.length !== 4) {
      node.warn(`Invalid raw_boxes format in detection: expected 4 corner points, got ${det.raw_boxes}`);
      return null;
    }

    try {
      // Parse 4 corner points: [[x1,y1], [x2,y1], [x2,y2], [x1,y2]]
      const [[x1, y1], [x2, y1_check], [x2_check, y2], [x1_check, y2_check]] = det.raw_boxes;

      // Validate corner format consistency
      if (x2 !== x2_check || x1 !== x1_check || y1 !== y1_check || y2 !== y2_check) {
        node.warn(`Inconsistent corner points in detection raw_boxes: ${JSON.stringify(det.raw_boxes)}`);
        return null;
      }

      // Coordinates are normalized (0-1), convert to pixels
      const imageWidth = image.width;
      const imageHeight = image.height;
      
      const x = Math.round(x1 * imageWidth);
      const y = Math.round(y1 * imageHeight);
      const width = Math.round((x2 - x1) * imageWidth);
      const height = Math.round((y2 - y1) * imageHeight);

      // Validate pixel coordinates
      if (width <= 0 || height <= 0) {
        node.warn(`Invalid dimensions: width=${width}, height=${height} for raw_boxes ${JSON.stringify(det.raw_boxes)}`);
        return null;
      }

      // Ensure coordinates are within image bounds
      const clippedX = Math.max(0, Math.min(x, imageWidth - 1));
      const clippedY = Math.max(0, Math.min(y, imageHeight - 1));
      const clippedWidth = Math.min(width, imageWidth - clippedX);
      const clippedHeight = Math.min(height, imageHeight - clippedY);

      return {
        x: clippedX,
        y: clippedY,
        width: clippedWidth,
        height: clippedHeight,
        label: String(label),
        confidence: Number(confidence),
        originalBbox: { 
          x: clippedX, 
          y: clippedY, 
          width: clippedWidth, 
          height: clippedHeight,
          normalized: { x1, y1, x2, y2 }
        }
      };
    } catch (error) {
      node.warn(`Error parsing detection box: ${error.message}`);
      return null;
    }
  }

  RED.nodes.registerType("cropBB", CropBBNode);
};
