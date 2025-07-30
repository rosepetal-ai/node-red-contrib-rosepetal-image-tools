/**
 * @file Contains generic helper functions for the Node-RED nodes.
 * This module is pure JavaScript and has no dependency on the RED object.
 * @author Rosepetal
 */

const sharp = require('sharp'); // Ensure sharp is installed in your project


module.exports = function(RED) {
  const utils = {};

  // Configuration constants
  const CONSTANTS = {
    DEFAULT_JPEG_QUALITY: 90,
    DEFAULT_ARRAY_POSITION: 0,
    SUPPORTED_DTYPES: ['uint8'],
    SUPPORTED_COLOR_SPACES: ['GRAY', 'RGB', 'RGBA', 'BGR', 'BGRA'],
    CHANNEL_MAP: { 'GRAY': 1, 'RGB': 3, 'RGBA': 4, 'BGR': 3, 'BGRA': 4 }
  };

  /**
   * Validates and normalizes an image structure
   * Supports both new structure {data, width, height, channels, colorSpace, dtype}
   * and legacy structure {data, width, height, channels: "int8_RGB"}
   */
  utils.validateImageStructure = function(image, node) {
    if (!image) {
      node.warn("Input is null or undefined");
      return null;
    }

    switch (true) {
      // New Rosepetal bitmap structure
      case (image.hasOwnProperty('width') &&
            image.hasOwnProperty('height') &&
            image.hasOwnProperty('data')):

        // Validate dtype (only uint8 supported for now)
        if (image.dtype && !CONSTANTS.SUPPORTED_DTYPES.includes(image.dtype)) {
          node.warn(`Unsupported dtype: ${image.dtype}. Supported values: ${CONSTANTS.SUPPORTED_DTYPES.join(', ')}`);
          return null;
        }

        // Infer channels if not provided
        let channels = image.channels;
        if (!channels) {
          const calculatedChannels = image.data.length / (image.width * image.height);
          if (!Number.isInteger(calculatedChannels)) {
            node.warn(`Cannot infer channels: data.length (${image.data.length}) is not divisible by width*height (${image.width * image.height})`);
            return null;
          }
          channels = calculatedChannels;
        }

        // Handle legacy string format ("int8_RGB")
        if (typeof channels === 'string') {
          const [, chanStr] = channels.split('_');
          if (CONSTANTS.CHANNEL_MAP[chanStr]) {
            channels = CONSTANTS.CHANNEL_MAP[chanStr];
          } else {
            node.warn(`Unknown legacy channel format: ${channels}`);
            return null;
          }
        }

        // Validate data length matches dimensions
        if (image.width * image.height * channels !== image.data.length) {
          node.warn(`Data length mismatch: expected ${image.width * image.height * channels} bytes (${image.width}x${image.height}x${channels}), got ${image.data.length} bytes`);
          return null;
        }

        // Handle colorSpace with defaults
        let colorSpace = image.colorSpace;
        if (!colorSpace) {
          // For legacy format, extract from string
          if (typeof image.channels === 'string') {
            const [, chanStr] = image.channels.split('_');
            colorSpace = chanStr || 'RGB';
          } else {
            // Default based on channel count
            switch (channels) {
              case 1: colorSpace = "GRAY"; break;
              case 3: colorSpace = "RGB"; break;
              case 4: colorSpace = "RGBA"; break;
              default:
                node.warn(`Cannot determine default colorSpace for ${channels} channels`);
                return null;
            }
          }
        }

        // Validate colorSpace matches channel count
        if (!CONSTANTS.CHANNEL_MAP.hasOwnProperty(colorSpace)) {
          node.warn(`Unsupported colorSpace: ${colorSpace}. Supported values: ${CONSTANTS.SUPPORTED_COLOR_SPACES.join(', ')}`);
          return null;
        }

        if (CONSTANTS.CHANNEL_MAP[colorSpace] !== channels) {
          node.warn(`ColorSpace mismatch: ${colorSpace} expects ${CONSTANTS.CHANNEL_MAP[colorSpace]} channels, got ${channels} channels`);
          return null;
        }

        // Return normalized structure
        return {
          data: image.data,
          width: image.width,
          height: image.height,
          channels: channels,
          colorSpace: colorSpace,
          dtype: image.dtype || 'uint8'
        };

      default:
        // Not our format? Pass to C++ and let OpenCV handle it
        return image;
    }
  }

  utils.validateSingleImage = function(image, node) {
    const normalized = utils.validateImageStructure(image, node);
    return normalized !== null;
  }

  utils.validateListImage = function(list, node) {
    if (!list || !Array.isArray(list) || list.length === 0) {
      node.warn("Input is not a valid image list. Expected a non-empty Array.");
      return false;
    }
    // Validate each item in the list
    for (const image of list) {
      if (!utils.validateSingleImage(image, node)) {
        // The warning message is already sent by validateSingleImage
        return false;
      }
    }
    return true;
  }

  utils.resolveDimension = function(node, type, value, msg) {
    if (!value || String(value).trim() === '') return null;
    let resolvedValue;
    if (type === 'msg' || type === 'flow' || type === 'global') {
        resolvedValue = RED.util.evaluateNodeProperty(value, type, node, msg);
    } else {
        resolvedValue = value;
    }
    const numericValue = parseFloat(resolvedValue);
    if (numericValue === undefined || isNaN(numericValue)) {
        throw new Error(`Value "${resolvedValue}" from property "${value}" is not a valid number.`);
    }
    return numericValue;
  }

  utils.rawToJpeg = async function (image, quality = CONSTANTS.DEFAULT_JPEG_QUALITY) {
    const normalized = utils.validateImageStructure(image, { warn: () => {} });
    if (!normalized)
      throw new Error('Invalid raw image object supplied to rawToJpeg');

    const colorSpace = normalized.colorSpace;
    const channels = normalized.channels;
    let data = normalized.data;

    // BGR/BGRA → RGB/RGBA for Sharp
    if (colorSpace === 'BGR' || colorSpace === 'BGRA') {
      data = Buffer.from(data); // copy so we don't mutate shared memory
      for (let i = 0; i < data.length; i += channels) {
        const t = data[i];
        data[i] = data[i + 2];
        data[i + 2] = t;
      }
    }

    const sh = sharp(data, {
      raw: { width: normalized.width, height: normalized.height, channels }
    });

    if (colorSpace === 'GRAY') sh.toColourspace('b-w');

    return sh.jpeg({ quality }).toBuffer();
  }

  /**
   * Standardized error handling for all nodes
   * @param {object} node - Node-RED node instance
   * @param {Error} error - The error that occurred
   * @param {object} msg - The message object
   * @param {function} done - The done callback
   * @param {string} operation - Optional operation name for context
   */
  utils.handleNodeError = function(node, error, msg, done, operation = 'processing') {
    const errorMessage = error.message || `Unknown error during ${operation}.`;
    node.error(errorMessage, msg);
    node.status({ fill: "red", shape: "ring", text: "Error" });
    if (done) {
      done(error);
    }
  }

  /**
   * Standardized success status formatting
   * @param {object} node - Node-RED node instance  
   * @param {number} count - Number of items processed
   * @param {number} totalTime - Total processing time in ms
   * @param {object} timing - Timing breakdown object
   */
  utils.setSuccessStatus = function(node, count, totalTime, timing = {}) {
    const { convertMs = 0, taskMs = 0, encodeMs = 0 } = timing;
    node.status({
      fill: 'green',
      shape: 'dot',
      text: `OK: ${count} img in ${totalTime.toFixed(2)} ms ` +
            `(conv ${(convertMs + encodeMs).toFixed(2)} ms | ` +
            `task ${taskMs.toFixed(2)} ms)`
    });
  }

  /**
   * Debug image display utility for inline node debugging
   * Converts images to displayable format and returns data URL with format message
   * @param {object|Buffer} image - Image data (raw image object or encoded buffer)
   * @param {string} outputFormat - The output format selected ('raw', 'jpg', 'png', 'webp')
   * @param {number} quality - JPEG quality for raw conversion (default: 90)
   * @param {object} node - Node-RED node instance for error reporting
   * @param {boolean} debugEnabled - Whether debugging is enabled
   * @param {number} debugWidth - Desired width for debug image display (default: 200)
   * @returns {Promise<object|null>} Debug result object with dataUrl and formatMessage, or null if disabled
   */
  utils.debugImageDisplay = async function(image, outputFormat, quality, node, debugEnabled, debugWidth) {
    if (!debugEnabled) return null;
    
    // Validate and set default debug width
    debugWidth = Math.max(1, parseInt(debugWidth) || 200);
    
    try {
      let imageBuffer, formatMessage;
      
      if (outputFormat === 'raw') {
        // Convert raw image to JPG for display using existing utility
        imageBuffer = await utils.rawToJpeg(image, quality || CONSTANTS.DEFAULT_JPEG_QUALITY);
        formatMessage = 'jpg default';
      } else {
        // Reuse existing converted buffer
        imageBuffer = Buffer.isBuffer(image) ? image : image.data;
        formatMessage = outputFormat; // 'jpg', 'png', 'webp'
      }
      
      if (!Buffer.isBuffer(imageBuffer)) {
        node.warn('Debug display: Invalid image buffer format');
        return null;
      }
      
      // Resize image for debug display using Sharp
      let actualWidth = debugWidth;
      let actualHeight = debugWidth; // Default fallback
      try {
        let sharpInstance = sharp(imageBuffer)
          .resize(debugWidth, null, {
            withoutEnlargement: false,
            fit: 'inside'
          });
        
        // Only convert format if output is raw, otherwise preserve the existing format
        if (outputFormat === 'raw') {
          // For raw format, convert to JPEG for display
          sharpInstance = sharpInstance.jpeg({ quality: quality || 90 });
          formatMessage = 'jpg default';
        } else {
          // For other formats (jpg, png, webp), just resize without format conversion
          // The C++ backend has already converted to the desired format
          formatMessage = outputFormat + ' resized';
        }
        
        imageBuffer = await sharpInstance.toBuffer();
        
        // Get actual dimensions of resized image
        const metadata = await sharp(imageBuffer).metadata();
        actualWidth = metadata.width || debugWidth;
        actualHeight = metadata.height || debugWidth;
        
      } catch (resizeError) {
        node.warn(`Debug image resize error: ${resizeError.message}`);
        // Continue with original image if resize fails
        // Try to get original dimensions as fallback
        try {
          const originalMetadata = await sharp(imageBuffer).metadata();
          actualWidth = originalMetadata.width || debugWidth;
          actualHeight = originalMetadata.height || debugWidth;
        } catch (metadataError) {
          // Use debug width as fallback
          actualWidth = debugWidth;
          actualHeight = debugWidth;
        }
      }
      
      // Convert to base64 for WebSocket transmission
      const base64 = imageBuffer.toString('base64');
      const mimeType = formatMessage.replace(' default', '').replace(' resized', '');
      const dataUrl = `data:image/${mimeType};base64,${base64}`;
      
      // Send image to frontend via WebSocket for inline display
      try {
        RED.comms.publish("debug-image", {
          id: node.id,
          data: base64,
          format: formatMessage,
          mimeType: mimeType,
          size: imageBuffer.length,
          debugWidth: actualWidth,
          debugHeight: actualHeight
        });
      } catch (wsError) {
        node.warn(`Debug WebSocket error: ${wsError.message}`);
        // Continue anyway - status display will still work
      }
      
      return {
        dataUrl: dataUrl,
        formatMessage: formatMessage,
        size: imageBuffer.length
      };
      
    } catch (error) {
      node.warn(`Debug display error: ${error.message}`);
      return null;
    }
  }

  /**
   * Enhanced success status formatting with debug information
   * @param {object} node - Node-RED node instance  
   * @param {number} count - Number of items processed
   * @param {number} totalTime - Total processing time in ms
   * @param {object} timing - Timing breakdown object
   * @param {string} debugFormat - Optional debug format message to include in status
   */
  utils.setSuccessStatusWithDebug = function(node, count, totalTime, timing = {}, debugFormat = null) {
    const { convertMs = 0, taskMs = 0, encodeMs = 0 } = timing;
    let statusText = `OK: ${count} img in ${totalTime.toFixed(2)} ms ` +
                    `(conv ${(convertMs + encodeMs).toFixed(2)} ms | ` +
                    `task ${taskMs.toFixed(2)} ms)`;
    
    if (debugFormat) {
      statusText += ` | ${debugFormat}`;
    }
    
    node.status({
      fill: 'green',
      shape: 'dot',
      text: statusText
    });
  }

  return utils;
}
