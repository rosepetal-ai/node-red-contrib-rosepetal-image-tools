/**
 * @file Node.js logic for the resize node (Final Refactored Version).
 * Handles both single image objects and lists of images with a single, clean logic path.
 * @author Rosepetal
 */
const { performance } = require('perf_hooks');
const CppProcessor = require('../../lib/cpp-bridge.js');
const NodeUtils = require('../../lib/node-utils.js');

module.exports = function(RED) {
  // Enhanced dimension resolver function
  function resolveDimension(node, config, mode, type, value, msg, originalDim) {
    if (!value || String(value).trim() === '') return null;
    
    let numericValue;
    // RED.util.evaluateNodeProperty is the most robust way to get values
    // from msg, flow, or global context.
    if (type === 'msg' || type === 'flow' || type === 'global') {
      numericValue = RED.util.evaluateNodeProperty(value, type, node, msg);
    } else { // type === 'num'
      numericValue = parseFloat(value);
    }

    if (numericValue === undefined || isNaN(numericValue)) {
      throw new Error(`Value for property "${value}" could not be resolved to a valid number.`);
    }

    if (mode === 'multiply') {
      return Math.round(originalDim * numericValue);
    }
    return Math.round(numericValue);
  }

  function ResizeNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.on('input', async function(msg, send, done) {
      try {
        node.status({});
        const inputPath = config.inputPath || "payload";
        const outputPath = config.outputPath || "payload";
        
        const originalPayload = RED.util.getMessageProperty(msg, inputPath);

        // STEP 1: Normalize The Input
        // Always treat the input as an array, even if it's a single image.
        const imageList = Array.isArray(originalPayload) ? originalPayload : [originalPayload];

        // STEP 2: Unified Validation
        // Use our utility function to validate the list we now always have.
        if (!NodeUtils.validateListImage(imageList, node)) {
            if (done) { done(); } 
            return;
        }

        const startTime = performance.now();
        const promises = [];

        // STEP 3: Unified Processing Loop
        // This single loop works for 1 or N images without changing the logic.
        for (const inputImage of imageList) {
          let targetWidth = resolveDimension(node, config, config.widthMode, config.widthType, config.widthValue, msg, inputImage.width);
          let targetHeight = resolveDimension(node, config, config.heightMode, config.heightType, config.heightValue, msg, inputImage.height);
          
          const aspectRatio = inputImage.width / inputImage.height;
          if (targetWidth && !targetHeight) {
            targetHeight = Math.round(targetWidth / aspectRatio);
          } else if (!targetWidth && targetHeight) {
            targetWidth = Math.round(targetHeight * aspectRatio);
          } else if (!targetWidth && !targetHeight) {
            throw new Error("Cannot resize: both width and height are unspecified.");
          }
          
          promises.push(CppProcessor.resize(inputImage, targetWidth, targetHeight));
        }
        
        const results = await Promise.all(promises);
        const endTime = performance.now();
        const duration = (endTime - startTime).toFixed(2);
        
        node.status({ fill: "green", shape: "dot", text: `OK: ${results.length} img in ${duration} ms`});

        // STEP 4: De-normalize the Output
        // If the original input was a single object, the output should also be a single object.
        const finalOutput = Array.isArray(originalPayload) ? results : results[0];

        RED.util.setMessageProperty(msg, outputPath, finalOutput);
        msg.processingTime_ms = parseFloat(duration);
        
        send(msg);
        if (done) { done(); }

      } catch (err) {
        NodeUtils.handleNodeError(node, err, msg, done);
      }
    });
  }
  RED.nodes.registerType("rosepetal-resize", ResizeNode);
};