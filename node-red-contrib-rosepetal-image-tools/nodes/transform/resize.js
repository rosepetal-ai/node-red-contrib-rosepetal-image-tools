/**
 * @file Node.js logic for the resize node (Final Refactored Version).
 * Handles both single image objects and lists of images with a single, clean logic path.
 * @author Rosepetal
 */
const { performance } = require('perf_hooks');
const CppProcessor = require('../../lib/cpp-bridge.js');
const sharp = require('sharp'); 

module.exports = function(RED) {
  const NodeUtils = require('../../lib/node-utils.js')(RED);


  function ResizeNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.on('input', async function(msg, send, done) {
      try {
        node.status({});
        const inputPath = config.inputPath || "payload";
        const outputPath = config.outputPath || "payload";
        const outputAsJpg  = !!config.outputAsJpg;
        
        const originalPayload = RED.util.getMessageProperty(msg, inputPath);
        const inputList = Array.isArray(originalPayload) ? originalPayload : [originalPayload];
        const promises = [];

        for (const inputImage of inputList) {
          let originalWidth, originalHeight; 

          if (Buffer.isBuffer(inputImage)) {
            // Es un buffer de fichero, usamos sharp.metadata() para leer las dimensiones rápidamente.
            const metadata = await sharp(inputImage).metadata();
            originalWidth = metadata.width;
            originalHeight = metadata.height;
          } else {
            // Es nuestro objeto raw, ya tenemos las dimensiones.
            originalWidth = inputImage.width;
            originalHeight = inputImage.height;
          }

          
          // Resolve dimensions based on the configuration
          let targetWidth = NodeUtils.resolveDimension(node, config.widthType, config.widthValue, msg);
          if (config.widthMode === 'multiply' && targetWidth !== null) {
            targetWidth = Math.round(originalWidth * targetWidth);
          }
          let targetHeight = NodeUtils.resolveDimension(node, config.heightType, config.heightValue, msg);
          if (config.heightMode === 'multiply' && targetHeight !== null) {
            targetHeight = Math.round(originalHeight * targetHeight);
          }
          const aspectRatio = originalWidth / originalHeight;
          if (targetWidth && !targetHeight) {
            targetHeight = Math.round(targetWidth / aspectRatio);
          } else if (!targetWidth && targetHeight) {
            targetWidth = Math.round(targetHeight * aspectRatio);
          } else if (!targetWidth && !targetHeight) {
            throw new Error("Cannot resize: both width and height are unspecified.");
          }

          console.log(`Resizing image to ${targetWidth}x${targetHeight}`);
          promises.push(CppProcessor.resize(inputImage, targetWidth, targetHeight, outputAsJpg));

        }

        const results = await Promise.all(promises);

        

        const { totalConvertMs, totalTaskMs, encodeMs, images } = results.reduce(
          (acc, { image, timing }) => {
            acc.totalConvertMs += timing?.convertMs ?? 0;
            acc.totalTaskMs   += timing?.taskMs   ?? 0;
            acc.encodeMs  += timing?.encodeMs ?? 0;
        
            acc.images.push(image);
            return acc;
          },
          { totalConvertMs: 0, totalTaskMs: 0, encodeMs: 0, images: [] } 
        );

        

        node.status({ fill: "green", shape: "dot", text: `OK: ${results.length} img in ${(totalConvertMs + totalTaskMs + encodeMs).toFixed(2)} ms. (Conversion: ${(totalConvertMs + encodeMs).toFixed(2)} ms. | Task: ${totalTaskMs.toFixed(2)} ms.)` });

        let out;

        if (outputAsJpg) {
          out = Array.isArray(originalPayload)
                ? images
                : images[0];
          console.log(`Raw output`);
        } else {
          // modo raw: mantenemos el objeto completo
          out = Array.isArray(originalPayload) ? images : images[0];
          console.log(`Raw output`);
        }
        RED.util.setMessageProperty(msg, outputPath, out);

        send(msg);
        if (done) { done(); }
      } catch (err) {
        NodeUtils.handleNodeError(node, err, msg, done);
      }
    });
  }
  RED.nodes.registerType("rosepetal-resize", ResizeNode);
};