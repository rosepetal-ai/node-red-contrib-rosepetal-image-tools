/**
 * @file Node.js logic for the Image-In node with dynamic output path.
 * Uses Sharp for complete image decoding and metadata extraction.
 * @author Rosepetal
 */

const sharp = require('sharp');
const fs = require('fs').promises;

module.exports = function(RED) {
  function ImageInNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.on('input', async function(msg, send, done) {
      try {
        const filePath = config.filePath || msg.filePath;
        if (!filePath) {
          node.warn("File path is not configured or provided in msg.filePath.");
          return;
        }

        node.status({ fill: "blue", shape: "dot", text: "reading..." });
        
        // Check file accessibility
        try {
          await fs.access(filePath, fs.constants.R_OK);
        } catch (accessErr) {
          node.warn(`Cannot access file: ${filePath}`);
          return;
        }

        // Use Sharp to decode image with full metadata
        const { data, info } = await sharp(filePath)
          .raw()
          .toBuffer({ resolveWithObject: true });

        // Determine colorSpace from Sharp info
        let colorSpace;
        switch (info.channels) {
          case 1: colorSpace = 'GRAY'; break;
          case 3: colorSpace = 'RGB'; break;
          case 4: colorSpace = 'RGBA'; break;
          default: throw new Error(`Unsupported number of channels: ${info.channels}`);
        }
        
        // Create complete image structure with all metadata
        const outputImageObject = {
          data: data,
          width: info.width,
          height: info.height,
          channels: info.channels,
          colorSpace: colorSpace,
          dtype: "uint8"
        };
        
        const outputPath = config.outputPath || "payload";
        const outputPathType = config.outputPathType || "msg";

        if (outputPathType === 'msg') {
          RED.util.setMessageProperty(msg, outputPath, outputImageObject);
        } else if (outputPathType === 'flow') {
          node.context().flow.set(outputPath, outputImageObject);
        } else if (outputPathType === 'global') {
          node.context().global.set(outputPath, outputImageObject);
        }
        
        node.status({ fill: "green", shape: "dot", text: `${info.width}x${info.height} to ${outputPathType}.${outputPath}` });
        
        send(msg);
        if (done) { done(); }

      } catch (err) {
        node.status({ fill: "red", shape: "ring", text: "Error" });
        node.warn(`Error reading image file: ${err.message}`);
        // Don't send message on error
        if (done) { done(); }
      }
    });
  }
  RED.nodes.registerType("image-in", ImageInNode);
};