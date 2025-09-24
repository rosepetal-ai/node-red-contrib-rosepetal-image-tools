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
        const evaluateProperty = (value, type, fallbackType = 'str') => {
          return new Promise((resolve, reject) => {
            const actualType = type || fallbackType;
            try {
              RED.util.evaluateNodeProperty(value, actualType, node, msg, (err, result) => {
                if (err) {
                  reject(err);
                } else {
                  resolve(result);
                }
              });
            } catch (err) {
              reject(err);
            }
          });
        };

        // Resolve folder path (supports typed inputs)
        const folderPathType = config.folderPathType || 'str';
        let folderPath;
        if (['msg', 'flow', 'global', 'jsonata', 'env'].includes(folderPathType)) {
          folderPath = await evaluateProperty(config.folderPath, folderPathType);
        } else {
          folderPath = config.folderPath || '.';
        }

        if (folderPath === undefined || folderPath === null || String(folderPath).trim() === '') {
          throw new Error('Folder path is not configured or resolved.');
        }
        folderPath = String(folderPath);

        try {
          await fs.mkdir(folderPath, { recursive: true });
        } catch (mkdirErr) {
          throw new Error(`Cannot create directory: ${mkdirErr.message}`);
        }

        // Resolve optional maximum image count
        let maxImages = 0;
        const maxImagesType = config.maxImagesType || 'num';
        const maxImagesConfigured = !(
          config.maxImages === undefined ||
          config.maxImages === null ||
          (typeof config.maxImages === 'string' && config.maxImages.trim() === '')
        );

        if (maxImagesConfigured || ['msg', 'flow', 'global', 'jsonata', 'env'].includes(maxImagesType)) {
          try {
            const resolvedMax = await evaluateProperty(config.maxImages, maxImagesType);
            if (resolvedMax !== undefined && resolvedMax !== null && resolvedMax !== '') {
              const numericMax = parseInt(resolvedMax, 10);
              if (Number.isNaN(numericMax)) {
                throw new Error(`Value "${resolvedMax}" is not a valid integer.`);
              }
              if (numericMax < 0) {
                throw new Error('Value must be zero or a positive integer.');
              }
              maxImages = numericMax;
            }
          } catch (err) {
            throw new Error(`Unable to resolve max images: ${err.message}`);
          }
        }

        // Retrieve input image
        const inputPath = config.inputPath || 'payload';
        const inputPathType = config.inputPathType || 'msg';

        let image;
        if (inputPathType === 'msg') {
          image = RED.util.getMessageProperty(msg, inputPath);
        } else if (inputPathType === 'flow') {
          image = node.context().flow.get(inputPath);
        } else if (inputPathType === 'global') {
          image = node.context().global.get(inputPath);
        }

        if (!image) {
          throw new Error('No image data found at specified input path');
        }

        node.status({ fill: 'blue', shape: 'dot', text: 'saving...' });

        // Resolve optional full filename override
        let resolvedFullFilename = null;
        const fullNameType = config.filenameFullType || 'str';
        const hasFullNameConfig = !(
          config.filenameFull === undefined ||
          config.filenameFull === null ||
          (typeof config.filenameFull === 'string' && config.filenameFull.trim() === '')
        );

        if (hasFullNameConfig || ['msg', 'flow', 'global', 'jsonata', 'env'].includes(fullNameType)) {
          try {
            const evaluated = await evaluateProperty(config.filenameFull, fullNameType);
            if (evaluated !== undefined && evaluated !== null) {
              const trimmed = String(evaluated).trim();
              if (trimmed) {
                resolvedFullFilename = trimmed;
              }
            }
          } catch (err) {
            throw new Error(`Unable to resolve full filename: ${err.message}`);
          }
        }

        // Resolve prefix when full filename not provided
        const prefixType = config.filenamePrefixType || 'str';
        let prefixValue = config.filenamePrefix || '';
        if (['msg', 'flow', 'global', 'jsonata', 'env'].includes(prefixType)) {
          try {
            const evaluatedPrefix = await evaluateProperty(config.filenamePrefix, prefixType);
            prefixValue = evaluatedPrefix !== undefined && evaluatedPrefix !== null ? String(evaluatedPrefix) : '';
          } catch (err) {
            throw new Error(`Unable to resolve filename prefix: ${err.message}`);
          }
        }
        prefixValue = (prefixValue || '').trim();
        const prefix = prefixValue ? `${prefixValue}_` : 'image_';

        // Determine format & extension
        let format = (config.outputFormat || 'jpg').toLowerCase();
        if (!['jpg', 'png', 'webp'].includes(format)) {
          format = 'jpg';
        }
        let fileExtension = format === 'jpg' ? 'jpg' : format;

        // Build filename (timestamp-based fallback)
        const now = new Date();
        const timestamp = now.getFullYear().toString() +
                          (now.getMonth() + 1).toString().padStart(2, '0') +
                          now.getDate().toString().padStart(2, '0') + '_' +
                          now.getHours().toString().padStart(2, '0') +
                          now.getMinutes().toString().padStart(2, '0') +
                          now.getSeconds().toString().padStart(2, '0');

        let baseFilename;
        if (resolvedFullFilename) {
          if (/[\\/]/.test(resolvedFullFilename)) {
            throw new Error('Full filename must not include path separators');
          }
          const parsed = path.parse(resolvedFullFilename);
          if (parsed.ext) {
            const extLower = parsed.ext.slice(1).toLowerCase();
            if (!['jpg', 'jpeg', 'png', 'webp'].includes(extLower)) {
              throw new Error(`Unsupported extension in filename: ${parsed.ext}`);
            }
            fileExtension = parsed.ext.slice(1);
            format = extLower === 'jpeg' ? 'jpg' : extLower;
            baseFilename = parsed.name;
          } else {
            baseFilename = parsed.base;
          }
        } else {
          baseFilename = `${prefix}${timestamp}`;
        }

        if (!baseFilename || !String(baseFilename).trim()) {
          throw new Error('Filename could not be determined.');
        }
        baseFilename = String(baseFilename).trim();

        let filename = `${baseFilename}.${fileExtension}`;
        const originalFilename = filename;
        let filePath = path.join(folderPath, filename);

        if (config.overwriteProtection !== false) {
          let counter = 2;
          while (await fileExists(filePath)) {
            filename = `${baseFilename}_${counter}.${fileExtension}`;
            filePath = path.join(folderPath, filename);
            counter += 1;
            if (counter > 1000) {
              throw new Error('Too many file variations exist');
            }
          }
        }

        // Convert image to buffer based on format
        let outputBuffer;
        const quality = parseInt(config.outputQuality, 10) || 90;
        
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

        if (maxImages > 0) {
          try {
            await enforceMaxImages(folderPath, maxImages);
          } catch (policyErr) {
            node.warn(`Max images enforcement failed: ${policyErr.message}`);
          }
        }

        const renameOccurred = config.overwriteProtection !== false && filename !== originalFilename;

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
              const statusText = renameOccurred ?
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
          const statusText = renameOccurred ?
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

    async function enforceMaxImages(folderPath, maxCount) {
      if (maxCount <= 0) {
        return;
      }

      try {
        const entries = await fs.readdir(folderPath, { withFileTypes: true });
        const files = entries
          .filter((entry) => entry.isFile())
          .map((entry) => entry.name);

        if (files.length <= maxCount) {
          return;
        }

        const fileStats = [];
        for (const name of files) {
          try {
            const fullPath = path.join(folderPath, name);
            const stats = await fs.stat(fullPath);
            fileStats.push({
              name,
              path: fullPath,
              mtime: stats.mtimeMs,
            });
          } catch (err) {
            node.warn(`Unable to inspect file ${name}: ${err.message}`);
          }
        }

        fileStats.sort((a, b) => a.mtime - b.mtime);

        while (fileStats.length > maxCount) {
          const oldest = fileStats.shift();
          if (!oldest) {
            break;
          }
          try {
            await fs.unlink(oldest.path);
          } catch (err) {
            throw new Error(`Failed to remove ${oldest.name}: ${err.message}`);
          }
        }
      } catch (err) {
        throw new Error(`Unable to read folder "${folderPath}": ${err.message}`);
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
      
      let desiredState;
      if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'active')) {
        desiredState = !!req.body.active;
      } else {
        desiredState = !node.active; // Legacy behaviour
      }

      node.active = desiredState;
      
      // Update node status
      if (!node.active) {
        node.status({ fill: "grey", shape: "dot", text: "inactive" });
      } else {
        node.status({});
      }
      
      res.json({ active: node.active });
    } else {
      res.sendStatus(404);
    }
  });
  
  RED.nodes.registerType("image-out", ImageOutNode);
};
