/**
 * @file Node.js logic for the Image-Out node with timestamp-based naming.
 * Saves images to filesystem with automatic timestamp naming and overwrite protection.
 * @author Rosepetal
 */

let sharp;
try {
  sharp = require('sharp');
} catch (err) {
  sharp = null;
}
const fs = require('fs').promises;
const path = require('path');

module.exports = function(RED) {
  const NodeUtils = require('../../lib/node-utils.js')(RED);

  const dirCache = new Map();

  async function getCachedDir(folderPath) {
    if (dirCache.has(folderPath)) return dirCache.get(folderPath);
    let names;
    try {
      names = await fs.readdir(folderPath);
    } catch {
      names = [];
    }
    const set = new Set(names);
    dirCache.set(folderPath, set);
    return set;
  }

  function ImageOutNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    
    // Initialize node state
    node.active = config.active !== false; // Default to true if not set
    let diskCheckErrorLogged = false;
    
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
          const { value, error } = NodeUtils.safeGetMessageProperty(msg, inputPath);
          if (error) {
            throw new Error(`Invalid inputPath "${inputPath}": ${error.message}`);
          }
          image = value;
        } else if (inputPathType === 'flow') {
          image = node.context().flow.get(inputPath);
        } else if (inputPathType === 'global') {
          image = node.context().global.get(inputPath);
        }

        if (!image) {
          throw new Error('No image data found at specified input path');
        }

        if (!sharp) {
          throw new Error('Sharp is not available. Install "sharp" in your Node-RED userDir and restart Node-RED.');
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
        if (!['jpg', 'png', 'webp', 'bmp'].includes(format)) {
          format = 'jpg';
        }
        let fileExtension = format === 'jpg' ? 'jpg' : format;
        const pngCompression = Math.max(0, Math.min(9, parseInt(config.pngCompression, 10) || 0));
        const webpLossless = config.webpLossless === true || config.webpLossless === 'true';
        const webpSmartSubsample = config.webpSmartSubsample === true || config.webpSmartSubsample === 'true';
        const parsedEffort = parseInt(config.webpEffort, 10);
        const hasWebpEffort = Number.isInteger(parsedEffort);
        // Sharp expects 0-6 (6 = slowest/smallest); clamp to be safe
        const webpEffort = hasWebpEffort ? Math.min(6, Math.max(0, parsedEffort)) : null;

        // Build filename (timestamp-based fallback)
        const timestamp = new Date()
          .toISOString()
          .replace(/[-:]/g, '')
          .replace(/\.(\d{3})Z$/, '-$1Z')
          .replace('T', '_');

        let baseFilename;
        if (resolvedFullFilename) {
          if (/[\\/]/.test(resolvedFullFilename)) {
            throw new Error('Full filename must not include path separators');
          }
          const parsed = path.parse(resolvedFullFilename);
          if (parsed.ext) {
            const extLower = parsed.ext.slice(1).toLowerCase();
            if (!['jpg', 'jpeg', 'png', 'webp', 'bmp'].includes(extLower)) {
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
          const dirSet = await getCachedDir(folderPath);
          let counter = 2;
          while (dirSet.has(filename)) {
            filename = `${baseFilename}_${counter}.${fileExtension}`;
            filePath = path.join(folderPath, filename);
            counter += 1;
            if (counter > 1000) {
              throw new Error('Too many file variations exist');
            }
          }
        }

        const diskInfo = await getDiskUsageInfo(folderPath);
        if (diskInfo && diskInfo.usedRatio >= 0.9) {
          const usedPercent = (diskInfo.usedRatio * 100).toFixed(1);
          node.warn(`Storage at "${folderPath}" is ${usedPercent}% full. Skipping image save to avoid exhausting disk space.`);
          node.status({ fill: "yellow", shape: "ring", text: `disk ${usedPercent}% full` });
          if (done) done();
          return;
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
          const sameFormat =
            inputFormat === format ||
            (inputFormat === 'jpeg' && format === 'jpg');

          const needsWebpReencode =
            format === 'webp' && (webpLossless || hasWebpEffort);

          if (sameFormat && !needsWebpReencode) {
            // Same format and no special WebP options: save directly (fastest)
            outputBuffer = image;
          } else {
            // Different format or unknown input, re-encode using Sharp
            const sharpInstance = sharp(image);
            
            switch (format) {
              case 'jpg':
                outputBuffer = await sharpInstance.jpeg({ quality }).toBuffer();
                break;
              case 'png':
                outputBuffer = await sharpInstance.png({ compressionLevel: pngCompression }).toBuffer();
                break;
              case 'webp':
                {
                  const webpOptions = { quality };
                  if (webpLossless) webpOptions.lossless = true;
                  if (!webpLossless && webpSmartSubsample) webpOptions.smartSubsample = true;
                  if (hasWebpEffort) webpOptions.effort = webpEffort;
                  outputBuffer = await sharpInstance.webp(webpOptions).toBuffer();
                }
                break;
              case 'bmp':
                throw new Error('BMP output requires raw image data, not an encoded buffer');
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
          
          // BMP: encode raw pixels directly (no Sharp)
          if (format === 'bmp') {
            let nativeData = data;
            if (colorSpace === 'RGB' || colorSpace === 'RGBA') {
              nativeData = Buffer.from(data);
              for (let i = 0; i < nativeData.length; i += channels) {
                const t = nativeData[i]; nativeData[i] = nativeData[i + 2]; nativeData[i + 2] = t;
              }
            }
            const buf = Buffer.isBuffer(nativeData) ? nativeData : Buffer.from(nativeData);
            outputBuffer = encodeBmpRaw(buf, validatedImage.width, validatedImage.height, channels);
          } else {
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
                {
                  const webpOptions = { quality };
                  if (webpLossless) webpOptions.lossless = true;
                  if (!webpLossless && webpSmartSubsample) webpOptions.smartSubsample = true;
                  if (hasWebpEffort) webpOptions.effort = webpEffort;
                  outputBuffer = await sharpInstance.webp(webpOptions).toBuffer();
                }
                break;
              default:
                throw new Error(`Unsupported format: ${format}`);
            }
          }
        }
        
        // Write file to disk
        await fs.writeFile(filePath, outputBuffer);
        dirCache.get(folderPath)?.add(filename);

        if (maxImages > 0) {
          try {
            await enforceMaxImages(folderPath, maxImages, dirCache.get(folderPath));
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
        const { message, hint } = NodeUtils.explainError(err, 'image-out', {
          inputPath: config.inputPath || 'payload',
          inputPathType: config.inputPathType || 'msg',
          folderPath: config.folderPath,
          outputFormat: config.outputFormat || 'jpg'
        });
        node.error(`Error saving image: ${message}`, msg);
        if (hint) {
          node.warn(`Hint: ${hint}`);
        }
        if (done) done(err);
      }
    });
    
    async function getDiskUsageInfo(targetPath) {
      try {
        const stats = await fs.statfs(targetPath);
        const blockSize = Number(stats.bsize) || 0;
        const totalBlocks = Number(stats.blocks) || 0;
        const availableBlocks = Number(
          stats.bavail !== undefined ? stats.bavail :
          stats.bfree !== undefined ? stats.bfree : 0
        );

        const totalBytes = totalBlocks * blockSize;
        const availableBytes = availableBlocks * blockSize;

        if (totalBytes <= 0) {
          return null;
        }

        const usedRatio = 1 - (availableBytes / totalBytes);
        return {
          totalBytes,
          availableBytes,
          usedRatio
        };
      } catch (err) {
        if (!diskCheckErrorLogged) {
          node.warn(`Disk usage check failed for "${targetPath}": ${err.message}`);
          diskCheckErrorLogged = true;
        }
        return null;
      }
    }

    async function enforceMaxImages(folderPath, maxCount, cachedSet) {
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
            cachedSet?.delete(oldest.name);
          } catch (err) {
            throw new Error(`Failed to remove ${oldest.name}: ${err.message}`);
          }
        }
      } catch (err) {
        throw new Error(`Unable to read folder "${folderPath}": ${err.message}`);
      }
    }

    function encodeBmpRaw(pixelData, width, height, channels) {
      const bitsPerPixel = channels * 8;
      const rowBytes = width * channels;
      const rowPadding = (4 - (rowBytes % 4)) % 4;
      const paddedRowSize = rowBytes + rowPadding;

      const hasPalette = channels === 1;
      const paletteSize = hasPalette ? 256 * 4 : 0;
      const headerSize = 14;
      const infoHeaderSize = 40;
      const pixelDataOffset = headerSize + infoHeaderSize + paletteSize;
      const pixelDataSize = paddedRowSize * height;
      const fileSize = pixelDataOffset + pixelDataSize;

      const buf = Buffer.alloc(fileSize);

      // File header
      buf.write('BM', 0);
      buf.writeUInt32LE(fileSize, 2);
      buf.writeUInt32LE(0, 6); // reserved
      buf.writeUInt32LE(pixelDataOffset, 10);

      // Info header (BITMAPINFOHEADER)
      buf.writeUInt32LE(infoHeaderSize, 14);
      buf.writeInt32LE(width, 18);
      buf.writeInt32LE(height, 22); // positive = bottom-up
      buf.writeUInt16LE(1, 26); // planes
      buf.writeUInt16LE(bitsPerPixel, 28);
      buf.writeUInt32LE(0, 30); // compression (BI_RGB)
      buf.writeUInt32LE(pixelDataSize, 34);
      buf.writeInt32LE(2835, 38); // X pixels per meter (~72 DPI)
      buf.writeInt32LE(2835, 42); // Y pixels per meter
      buf.writeUInt32LE(hasPalette ? 256 : 0, 46);
      buf.writeUInt32LE(0, 50); // important colors

      // Grayscale palette
      if (hasPalette) {
        let offset = headerSize + infoHeaderSize;
        for (let i = 0; i < 256; i++) {
          buf[offset++] = i; // B
          buf[offset++] = i; // G
          buf[offset++] = i; // R
          buf[offset++] = 0; // reserved
        }
      }

      // Pixel data (bottom-up row order)
      const padBytes = Buffer.alloc(rowPadding);
      for (let y = height - 1; y >= 0; y--) {
        const srcOffset = y * rowBytes;
        const dstOffset = pixelDataOffset + (height - 1 - y) * paddedRowSize;
        pixelData.copy(buf, dstOffset, srcOffset, srcOffset + rowBytes);
        if (rowPadding > 0) {
          padBytes.copy(buf, dstOffset + rowBytes);
        }
      }

      return buf;
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
  
  RED.nodes.registerType("rp-image-out", ImageOutNode);
};
