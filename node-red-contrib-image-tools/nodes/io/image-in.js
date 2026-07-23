/**
 * @file Node.js logic for the Image-In node with dynamic output path.
 * Uses Sharp for complete image decoding and metadata extraction.
 * @author Rosepetal
 */

let sharp;
try {
  sharp = require('sharp');
} catch (err) {
  sharp = null;
}
const fs = require('fs').promises;
const BmpDecode = require('../../lib/bmp-decode.js');

module.exports = function(RED) {
  const NodeUtils = require('../../lib/node-utils.js')(RED);
  
  function ImageInNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.on('input', async function(msg, send, done) {
      try {
        if (!sharp) {
          throw new Error('Sharp is not available. Install "sharp" in your Node-RED userDir and restart Node-RED.');
        }
        let filePath;
        if (config.filePathType === 'msg' || config.filePathType === 'flow' || config.filePathType === 'global') {
          filePath = RED.util.evaluateNodeProperty(config.filePath, config.filePathType, node, msg);
        } else {
          filePath = config.filePath; // str type
        }
        
        if (!filePath) {
          node.warn("File path is not configured or resolved.");
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

        // Decode: BMP natively (Sharp cannot read it), everything else via Sharp
        const fileBuffer = await fs.readFile(filePath);
        let data, info;
        if (BmpDecode.isBmp(fileBuffer)) {
          const decoded = BmpDecode.decodeBmp(fileBuffer);
          data = decoded.data;
          info = { width: decoded.width, height: decoded.height, channels: decoded.channels };
        } else {
          ({ data, info } = await sharp(fileBuffer).raw().toBuffer({ resolveWithObject: true }));
        }

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
        
        // Debug image display if enabled
        if (config.debugEnabled) {
          try {
            // Resolve debug width
            let debugWidth = NodeUtils.resolveDimension(
              node,
              config.debugWidthType || "num",
              config.debugWidth || 200,
              msg
            );
            debugWidth = Math.max(1, parseInt(debugWidth) || 200);
            
            // Since we already have the image loaded, reuse it for debug display
            // Convert to JPEG buffer for debug display using the Sharp instance
            const debugBuffer = await sharp(data, {
              raw: { width: info.width, height: info.height, channels: info.channels }
            })
            .resize(debugWidth, null, {
              withoutEnlargement: false,
              fit: 'inside'
            })
            .jpeg({ quality: 90 })
            .toBuffer();
            
            // Create debug result manually since we're using Sharp directly
            const base64 = debugBuffer.toString('base64');
            const debugMetadata = await sharp(debugBuffer).metadata();
            
            // Send image to frontend via WebSocket for inline display
            try {
              RED.comms.publish("debug-image", {
                id: node.id,
                data: base64,
                format: 'jpg debug',
                mimeType: 'jpeg',
                size: debugBuffer.length,
                debugWidth: debugMetadata.width || debugWidth,
                debugHeight: debugMetadata.height || debugWidth
              });
            } catch (wsError) {
              node.warn(`Debug WebSocket error: ${wsError.message}`);
            }
            
          } catch (debugError) {
            node.warn(`Debug display error: ${debugError.message}`);
          }
        }
        
        const outputPath = config.outputPath || "payload";
        const outputPathType = config.outputPathType || "msg";

        if (outputPathType === 'msg') {
          RED.util.setMessageProperty(msg, outputPath, outputImageObject);
        } else if (outputPathType === 'flow') {
          node.context().flow.set(outputPath, outputImageObject);
        } else if (outputPathType === 'global') {
          node.context().global.set(outputPath, outputImageObject);
        }
        
        // Update status with debug info if enabled
        let statusText = `${info.width}x${info.height} to ${outputPathType}.${outputPath}`;
        if (config.debugEnabled) {
          statusText += ' | jpg debug';
        }
        node.status({ fill: "green", shape: "dot", text: statusText });
        
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
  RED.nodes.registerType("rp-image-in", ImageInNode);
};
