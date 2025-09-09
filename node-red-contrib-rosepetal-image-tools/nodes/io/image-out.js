/**
 * @file Node.js logic for the Image-Out node with timestamp-based naming.
 * Saves images to filesystem with automatic timestamp naming and overwrite protection.
 * @author Rosepetal
 */

const sharp = require('sharp');
const fs = require('fs').promises;
const path = require('path');

module.exports = function(RED) {
  const NodeUtils = require('../../lib/node-utils.js')(RED);
  
  function ImageOutNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    
    // Initialize node state
    node.active = config.active !== false; // Default to true if not set
    
    // Update node appearance based on active state
    updateNodeStatus();
    
    function updateNodeStatus() {
      if (!node.active) {
        node.status({ fill: "grey", shape: "dot", text: "inactive" });
      } else {
        node.status({}); // Clear status when active and idle
      }
    }
    
    node.on('input', async function(msg, send, done) {
      // Skip processing if node is inactive
      if (!node.active) {
        if (done) done();
        return;
      }
      
      const startTime = Date.now();
      
      try {
        // Get folder path
        let folderPath;
        if (config.folderPathType === 'msg' || config.folderPathType === 'flow' || config.folderPathType === 'global') {
          folderPath = RED.util.evaluateNodeProperty(config.folderPath, config.folderPathType, node, msg);
        } else {
          folderPath = config.folderPath || '.'; // Default to current directory
        }
        
        // Validate folder path
        if (!folderPath) {
          throw new Error("Folder path is not configured or resolved.");
        }
        
        // Ensure folder exists
        try {
          await fs.mkdir(folderPath, { recursive: true });
        } catch (mkdirErr) {
          throw new Error(`Cannot create directory: ${mkdirErr.message}`);
        }
        
        // Get input image
        const inputPath = config.inputPath || "payload";
        const inputPathType = config.inputPathType || "msg";
        
        let image;
        if (inputPathType === 'msg') {
          image = RED.util.getMessageProperty(msg, inputPath);
        } else if (inputPathType === 'flow') {
          image = node.context().flow.get(inputPath);
        } else if (inputPathType === 'global') {
          image = node.context().global.get(inputPath);
        }
        
        // Check if input is valid
        if (!image) {
          throw new Error("No image data found at specified input path");
        }
        
        node.status({ fill: "blue", shape: "dot", text: "saving..." });
        
        // Generate timestamp-based filename
        const now = new Date();
        const timestamp = now.getFullYear().toString() +
                         (now.getMonth() + 1).toString().padStart(2, '0') +
                         now.getDate().toString().padStart(2, '0') + '_' +
                         now.getHours().toString().padStart(2, '0') +
                         now.getMinutes().toString().padStart(2, '0') +
                         now.getSeconds().toString().padStart(2, '0');
        
        // Build filename with optional prefix (can be dynamic from msg/flow/global)
        let prefix;
        if (config.filenamePrefixType === 'msg' || config.filenamePrefixType === 'flow' || config.filenamePrefixType === 'global') {
          const resolvedPrefix = RED.util.evaluateNodeProperty(config.filenamePrefix, config.filenamePrefixType, node, msg);
          prefix = resolvedPrefix ? resolvedPrefix + '_' : 'image_';
        } else {
          prefix = config.filenamePrefix ? config.filenamePrefix + '_' : 'image_';
        }
        const format = config.outputFormat || 'jpg';
        const extension = format === 'jpg' ? 'jpg' : format;
        let baseFilename = `${prefix}${timestamp}`;
        let filename = `${baseFilename}.${extension}`;
        let filePath = path.join(folderPath, filename);
        
        // Handle overwrite protection
        if (config.overwriteProtection !== false) { // Default to true
          let counter = 2;
          while (await fileExists(filePath)) {
            filename = `${baseFilename}_${counter}.${extension}`;
            filePath = path.join(folderPath, filename);
            counter++;
            if (counter > 1000) { // Safety limit
              throw new Error("Too many file variations exist");
            }
          }
        }
        
        // Convert image to buffer based on format
        let outputBuffer;
        const quality = parseInt(config.outputQuality) || 90;
        
        // Check if image is already an encoded Buffer (JPEG, PNG, WebP)
        if (Buffer.isBuffer(image) && !image.width && !image.height) {
          // It's an encoded image buffer
          // We can either save it directly or re-encode if format is different
          
          // Try to detect the input format using Sharp metadata
          let inputFormat;
          try {
            const metadata = await sharp(image).metadata();
            inputFormat = metadata.format; // Will be 'jpeg', 'png', 'webp', etc.
          } catch (err) {
            // If we can't detect format, we'll re-encode anyway
            inputFormat = null;
          }
          
          // Check if we need to re-encode or can save directly
          if (inputFormat === format || (inputFormat === 'jpeg' && format === 'jpg')) {
            // Same format, we can save directly without re-encoding (fastest)
            outputBuffer = image;
          } else {
            // Different format or unknown input, re-encode using Sharp
            const sharpInstance = sharp(image);
            
            switch (format) {
              case 'jpg':
                outputBuffer = await sharpInstance.jpeg({ quality }).toBuffer();
                break;
              case 'png':
                const pngOptions = config.pngOptimize ? 
                  { compressionLevel: 9, palette: true } : 
                  { compressionLevel: 6 };
                outputBuffer = await sharpInstance.png(pngOptions).toBuffer();
                break;
              case 'webp':
                outputBuffer = await sharpInstance.webp({ quality }).toBuffer();
                break;
              default:
                throw new Error(`Unsupported format: ${format}`);
            }
          }
        } else {
          // It's raw image data - validate and process as before
          const validatedImage = NodeUtils.validateImageStructure(image, node);
          if (!validatedImage) {
            throw new Error("Invalid image structure");
          }
          
          // Convert from raw image format to Sharp-compatible format
          const colorSpace = validatedImage.colorSpace;
          const channels = validatedImage.channels;
          let data = validatedImage.data;
          
          // BGR/BGRA → RGB/RGBA for Sharp
          if (colorSpace === 'BGR' || colorSpace === 'BGRA') {
            data = Buffer.from(data); // Copy to avoid mutating shared memory
            for (let i = 0; i < data.length; i += channels) {
              const t = data[i];
              data[i] = data[i + 2];
              data[i + 2] = t;
            }
          }
          
          const sharpInstance = sharp(data, {
            raw: {
              width: validatedImage.width,
              height: validatedImage.height,
              channels: channels
            }
          });
          
          // Apply colorspace conversion if needed
          if (colorSpace === 'GRAY') {
            sharpInstance.toColourspace('b-w');
          }
          
          // Encode based on selected format
          switch (format) {
            case 'jpg':
              outputBuffer = await sharpInstance.jpeg({ quality }).toBuffer();
              break;
            case 'png':
              const pngOptions = config.pngOptimize ? 
                { compressionLevel: 9, palette: true } : 
                { compressionLevel: 6 };
              outputBuffer = await sharpInstance.png(pngOptions).toBuffer();
              break;
            case 'webp':
              outputBuffer = await sharpInstance.webp({ quality }).toBuffer();
              break;
            default:
              throw new Error(`Unsupported format: ${format}`);
          }
        }
        
        // Write file to disk
        await fs.writeFile(filePath, outputBuffer);
        
        // Debug display if enabled
        if (config.debugEnabled) {
          try {
            const debugResult = await NodeUtils.debugImageDisplay(
              outputBuffer,
              format,
              quality,
              node,
              true,
              config.debugWidth || 200
            );
            
            if (debugResult) {
              const wasOverwriteAvoided = config.overwriteProtection && filename !== `${prefix}${timestamp}.${extension}`;
              const statusText = wasOverwriteAvoided ? 
                `saved: ${filename} (avoided overwrite)` : 
                `saved: ${filename}`;
              
              node.status({ 
                fill: "green", 
                shape: "dot", 
                text: statusText + ` | ${format} debug`
              });
            }
          } catch (debugError) {
            node.warn(`Debug display error: ${debugError.message}`);
          }
        } else {
          const elapsedMs = Date.now() - startTime;
          const wasOverwriteAvoided = config.overwriteProtection && filename !== `${prefix}${timestamp}.${extension}`;
          const statusText = wasOverwriteAvoided ? 
            `saved: ${filename} (${elapsedMs}ms, avoided overwrite)` : 
            `saved: ${filename} (${elapsedMs}ms)`;
          
          node.status({ fill: "green", shape: "dot", text: statusText });
        }
        
        if (done) done();
        
      } catch (err) {
        node.status({ fill: "red", shape: "ring", text: "Error" });
        node.error(`Error saving image: ${err.message}`, msg);
        if (done) done(err);
      }
    });
    
    // Helper function to check if file exists
    async function fileExists(filePath) {
      try {
        await fs.access(filePath);
        return true;
      } catch {
        return false;
      }
    }
    
    // Handle cleanup
    node.on('close', function() {
      // Clear any debug images
      try {
        RED.comms.publish("debug-image", {
          id: node.id,
          data: null
        });
      } catch (err) {
        // Ignore cleanup errors
      }
    });
  }
  
  // Register HTTP endpoint for button state changes
  RED.httpAdmin.post("/image-out/:id", RED.auth.needsPermission("flows.write"), function(req, res) {
    const node = RED.nodes.getNode(req.params.id);
    if (node != null) {
      if (typeof node.active === "undefined") {
        node.active = true;
      }
      
      // Toggle state
      node.active = !node.active;
      
      // Update node status
      if (!node.active) {
        node.status({ fill: "grey", shape: "dot", text: "inactive" });
      } else {
        node.status({});
      }
      
      res.sendStatus(200);
    } else {
      res.sendStatus(404);
    }
  });
  
  RED.nodes.registerType("image-out", ImageOutNode);
};