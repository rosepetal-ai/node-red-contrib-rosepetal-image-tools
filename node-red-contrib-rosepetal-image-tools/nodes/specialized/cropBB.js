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

    node.on('input', async (msg, _send, done) => {
      try {
        const t0 = performance.now();
        node.status({});

        /* Input/Output paths */
        const imageInputPath = config.imageInputPath || 'images';
        const bboxInputPath = config.bboxInputPath || 'default';
        const outputPath = config.outputPath || 'payload';

        /* Configuration */
        const outputFormat = config.outputFormat || 'raw';
        const outputQuality = config.outputQuality || 90;
        const pngOptimize = config.pngOptimize || false;
        const minConfidence = NodeUtils.resolveDimension(node, config.minConfidenceType, config.minConfidence, msg) || 0.5;

        /* Get input data */
        const imageData = RED.util.getMessageProperty(msg, imageInputPath);
        const bboxData = RED.util.getMessageProperty(msg, bboxInputPath);

        if (!imageData) {
          node.error(`No image data found at ${imageInputPath}`);
          return;
        }

        if (!bboxData) {
          node.error(`No bounding box data found at ${bboxInputPath}`);
          return;
        }

        /* Handle single image vs array */
        const images = Array.isArray(imageData) ? imageData : [imageData];
        
        // The bboxData should be an array of detection objects
        if (!bboxData || !Array.isArray(bboxData)) {
          node.error(`Invalid bounding box data structure. Expected array at ${bboxInputPath}`);
          return;
        }
        
        const detections = bboxData;

        // Validate input images
        if (Array.isArray(imageData)) {
          if (!NodeUtils.validateListImage(imageData, node)) {
            return;
          }
        } else {
          if (!NodeUtils.validateSingleImage(imageData, node)) {
            return;
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
          if (done) done();
          return;
        }

        /* Create crop jobs for all valid bounding boxes */
        const cropJobs = validBboxes.map(bbox => {
          // Convert bbox coordinates to crop parameters
          const { x, y, width, height, label, confidence, originalBbox } = bbox;
          
          return CppProcessor.crop(image, x, y, width, height, false, outputFormat, outputQuality, pngOptimize)
            .then(result => ({
              crop: result.image,
              tag: {
                label: label,
                confidence: confidence,
                bbox: originalBbox
              },
              timing: result.timing
            }));
        });

        /* Execute all crops in parallel */
        const cropResults = await Promise.all(cropJobs);
        
        /* Accumulate results and timing */
        cropResults.forEach(result => {
          allCrops.push({
            crop: result.crop,
            tag: result.tag
          });
          
          totalConvertMs += result.timing?.convertMs ?? 0;
          totalTaskMs += result.timing?.taskMs ?? 0;
          totalEncodeMs += result.timing?.encodeMs ?? 0;
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
              allCrops[0].crop, 
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

        node.send(msg);
        if (done) done();
        
      } catch (error) {
        NodeUtils.handleNodeError(node, error, msg, done, 'cropBB processing');
      }
    });
  }

  /**
   * Parse a single detection object into standardized bbox format
   * Handles the specific inference format: 
   * {
   *   "box": [[x1,y1], [x2,y1], [x2,y2], [x1,y2]], // normalized 0-1 coordinates
   *   "confidence": 0.97,
   *   "class_name": "label",
   *   "class_tag": 3
   * }
   */
  function parseSingleDetection(det, minConfidence, image, node) {
    if (!det || typeof det !== 'object') return null;

    // Extract confidence
    const confidence = det.confidence || 1.0;
    if (confidence < minConfidence) return null;

    // Extract label - prefer class_name over class_tag
    const label = det.class_name || det.class_tag || det.label || 'unknown';

    // Extract coordinates from 4-corner format
    if (!det.box || !Array.isArray(det.box) || det.box.length !== 4) {
      node.warn(`Invalid box format in detection: expected 4 corner points, got ${det.box}`);
      return null;
    }

    try {
      // Parse 4 corner points: [[x1,y1], [x2,y1], [x2,y2], [x1,y2]]
      const [[x1, y1], [x2, y1_check], [x2_check, y2], [x1_check, y2_check]] = det.box;
      
      // Validate corner format consistency
      if (x2 !== x2_check || x1 !== x1_check || y1 !== y1_check || y2 !== y2_check) {
        node.warn(`Inconsistent corner points in detection box: ${JSON.stringify(det.box)}`);
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
        node.warn(`Invalid dimensions: width=${width}, height=${height} for box ${JSON.stringify(det.box)}`);
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