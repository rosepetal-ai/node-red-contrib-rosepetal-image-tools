/**
 * @file Contains generic helper functions for the Node-RED nodes.
 * This module is pure JavaScript and has no dependency on the RED object.
 * @author Rosepetal
 */

let sharp;
try {
  sharp = require('sharp');
} catch (err) {
  sharp = null;
}
const Cpp = require('./cpp-bridge.js');


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
   * Supports structure: {data, width, height, channels, colorSpace, dtype}
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

        const normalizeNumber = (value) => {
          if (typeof value === 'number') return value;
          if (typeof value === 'string') {
            const trimmed = value.trim();
            if (trimmed === '') return value;
            const parsed = Number(trimmed);
            return Number.isFinite(parsed) ? parsed : value;
          }
          return value;
        };

        const normalizeData = (data) => {
          if (!data) return data;
          if (Buffer.isBuffer(data)) return data;
          if (ArrayBuffer.isView(data)) {
            return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
          }
          if (data instanceof ArrayBuffer) {
            return Buffer.from(data);
          }
          if (Array.isArray(data)) {
            return Buffer.from(data);
          }
          if (typeof data === 'object') {
            if (data.type === 'Buffer' && Array.isArray(data.data)) {
              return Buffer.from(data.data);
            }
            if (Array.isArray(data.data)) {
              return Buffer.from(data.data);
            }
          }
          return data;
        };

        // Normalize width/height to numbers when possible
        const width = normalizeNumber(image.width);
        const height = normalizeNumber(image.height);
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
          node.warn(`Invalid image dimensions: width=${image.width}, height=${image.height}`);
          return null;
        }

        // Normalize data for serialized Buffer/typed arrays
        const normalizedData = normalizeData(image.data);
        if (!normalizedData || typeof normalizedData.length !== 'number') {
          node.warn('Image data is missing or not a valid buffer/array');
          return null;
        }

        // Validate dtype (only uint8 supported for now)
        if (image.dtype && !CONSTANTS.SUPPORTED_DTYPES.includes(image.dtype)) {
          node.warn(`Unsupported dtype: ${image.dtype}. Supported values: ${CONSTANTS.SUPPORTED_DTYPES.join(', ')}`);
          return null;
        }

        // Infer channels if not provided
        let channels = image.channels;
        if (!channels) {
          const calculatedChannels = normalizedData.length / (width * height);
          if (!Number.isInteger(calculatedChannels)) {
            node.warn(`Cannot infer channels: data.length (${normalizedData.length}) is not divisible by width*height (${width * height})`);
            return null;
          }
          channels = calculatedChannels;
        }

        if (typeof channels === 'string' && channels.trim() !== '') {
          const parsedChannels = Number(channels);
          channels = Number.isFinite(parsedChannels) ? parsedChannels : channels;
        }

        // Validate channels is a number
        if (typeof channels !== 'number' || !Number.isFinite(channels) || !Number.isInteger(channels)) {
          node.warn(`Channels must be a number, got: ${typeof channels}`);
          return null;
        }

        // Validate data length matches dimensions
        if (width * height * channels !== normalizedData.length) {
          node.warn(`Data length mismatch: expected ${width * height * channels} bytes (${width}x${height}x${channels}), got ${normalizedData.length} bytes`);
          return null;
        }

        // Handle colorSpace with defaults
        let colorSpace = image.colorSpace;
        if (!colorSpace) {
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

        if (typeof colorSpace === 'string') {
          colorSpace = colorSpace.trim().toUpperCase();
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
          data: normalizedData,
          width: width,
          height: height,
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

  /**
   * Safe wrapper around RED.util.getMessageProperty.
   * Node-RED can throw on paths like "images[0]" when the intermediate object is undefined.
   */
  utils.safeGetMessageProperty = function(msg, path) {
    try {
      return { value: RED.util.getMessageProperty(msg, path), error: null };
    } catch (error) {
      return { value: undefined, error };
    }
  }

  utils.getInputValue = function(node, msg, path, pathType = 'msg') {
    const type = pathType || 'msg';
    if (type === 'msg') {
      return utils.safeGetMessageProperty(msg, path);
    }
    if (type === 'flow') {
      return { value: node.context().flow.get(path), error: null };
    }
    if (type === 'global') {
      return { value: node.context().global.get(path), error: null };
    }
    try {
      return { value: RED.util.evaluateNodeProperty(path, type, node, msg), error: null };
    } catch (error) {
      return { value: undefined, error };
    }
  }

  utils.setOutputValue = function(node, msg, path, pathType = 'msg', value) {
    const type = pathType || 'msg';
    if (type === 'msg') {
      RED.util.setMessageProperty(msg, path, value);
      return;
    }
    if (type === 'flow') {
      node.context().flow.set(path, value);
      return;
    }
    if (type === 'global') {
      node.context().global.set(path, value);
      return;
    }
    RED.util.setMessageProperty(msg, path, value);
  }

  utils._inferErrorHint = function(errorMessage, operation, context = {}) {
    const inputPath = context.inputPath || context.inPath || context.imagePath || context.masksPath;

    if (/Invalid inputPath\b/.test(errorMessage) || /Invalid .*Path\b/.test(errorMessage) ||
        /Cannot read properties of undefined \(reading '0'\)/.test(errorMessage)) {
      if (inputPath) {
        return `Check that msg has "${inputPath}" before this node. If you use "[0]" indexing, ensure the array exists and is not empty.`;
      }
      return 'Check your input path(s): an intermediate object is undefined (common with "foo[0]" when foo is missing).';
    }

    if (errorMessage.includes('not a valid number')) {
      return 'Check the TypedInput type (num/msg/flow/global) and ensure the resolved value exists and is numeric.';
    }

    if (/Invalid image/.test(errorMessage) || /image structure/.test(errorMessage) || /image list/.test(errorMessage)) {
      return 'Provide a valid image (Buffer, or {data,width,height,channels,colorSpace,dtype}). Using the "image-in" node output is the easiest way.';
    }

    if (/Failed to decode image buffer/.test(errorMessage)) {
      return 'The input Buffer is not a valid encoded image (jpg/png/webp). Ensure upstream provides a real image buffer.';
    }

    if (/Could not load the rosepetal-image-engine native addon/.test(errorMessage)) {
      return 'Install the correct prebuilt package for your platform, or build from source (OpenCV 4.x + build tools) and restart Node-RED.';
    }

    if (/OpenCV\(/.test(errorMessage) || /cv::/.test(errorMessage)) {
      return 'Native OpenCV error: check your parameters (sizes > 0, multiply factors > 0). If it tries to allocate huge memory, your computed dimensions are wrong.';
    }

    if (operation === 'validation') {
      return 'Fix the node configuration or the incoming msg fields based on the validation error details.';
    }

    return null;
  }

  utils._safeTopLevelKeys = function(msg) {
    try {
      const keys = Object.keys(msg || {});
      return keys.slice(0, 30);
    } catch {
      return [];
    }
  }

  utils.explainError = function(error, operation, context = {}) {
    const message = error instanceof Error ? (error.message || String(error)) : String(error);
    const hint = context.hint || utils._inferErrorHint(message, operation, context) || undefined;

    const details = {
      operation,
      ...context
    };

    if (details.msg && typeof details.msg === 'object') {
      // Avoid putting the whole msg on msg.error; keep only lightweight info.
      details.msgKeys = utils._safeTopLevelKeys(details.msg);
      delete details.msg;
    }

    return { message, hint, details };
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

  /**
   * Resolves array position value from various sources (msg, flow, global, or direct value)
   * @param {Object} node - The Node-RED node instance
   * @param {string} type - The type of source ('msg', 'flow', 'global', or 'num')
   * @param {*} value - The value or property path to resolve
   * @param {Object} msg - The message object for msg property resolution
   * @returns {number} The resolved array position as a non-negative integer
   * @throws {Error} If the resolved value is not a valid non-negative integer
   */
  utils.resolveArrayPosition = function(node, type, value, msg) {
    if (value === null || value === undefined || String(value).trim() === '') {
      return CONSTANTS.DEFAULT_ARRAY_POSITION;
    }
    
    let resolvedValue;
    if (type === 'msg' || type === 'flow' || type === 'global') {
      resolvedValue = RED.util.evaluateNodeProperty(value, type, node, msg);
    } else {
      resolvedValue = value;
    }
    
    const numericValue = parseInt(resolvedValue);
    if (numericValue === undefined || isNaN(numericValue) || numericValue < 0) {
      throw new Error(`Array position "${resolvedValue}" from property "${value}" must be a non-negative integer.`);
    }
    
    return numericValue;
  }

  /**
   * Returns true when any advanced WebP option is explicitly set in the node config.
   * When false the fast C++ encoding path is used unchanged.
   */
  utils.hasAdvancedWebpOptions = function(config) {
    if (!config) return false;
    if (config.webpLossless === true || config.webpLossless === 'true') return true;
    if (config.webpSmartSubsample === true || config.webpSmartSubsample === 'true') return true;
    if (config.webpEffort !== undefined && config.webpEffort !== '' && config.webpEffort !== null) return true;
    return false;
  }

  /**
   * Builds a Sharp `.webp()` options object from node config.
   */
  utils.buildWebpOptions = function(config) {
    const opts = {};
    const quality = parseInt(config.outputQuality);
    if (Number.isFinite(quality) && quality >= 1 && quality <= 100) opts.quality = quality;
    else opts.quality = CONSTANTS.DEFAULT_JPEG_QUALITY;

    if (config.webpLossless === true || config.webpLossless === 'true') opts.lossless = true;
    if (config.webpSmartSubsample === true || config.webpSmartSubsample === 'true') opts.smartSubsample = true;
    const effort = parseInt(config.webpEffort);
    if (Number.isFinite(effort) && effort >= 0 && effort <= 6) opts.effort = effort;
    return opts;
  }

  /**
   * Returns a Sharp-compatible raw image (GRAY / RGB / RGBA) for a normalized
   * raw image object. BGR/BGRA inputs are converted by the native engine on
   * the libuv thread pool — never with a pixel loop on the event loop.
   * @returns {Promise<{data: Buffer, width: number, height: number, channels: number, colorSpace: string}>}
   */
  utils.toSharpRaw = async function(normalized) {
    const colorSpace = normalized.colorSpace;
    if (colorSpace !== 'BGR' && colorSpace !== 'BGRA') return normalized;
    const target = colorSpace === 'BGR' ? 'RGB' : 'RGBA';
    const { image } = await Cpp.colorConvert(normalized, target, 'raw');
    return image;
  }

  /**
   * Encodes a raw image object to WebP via Sharp with advanced options.
   * Modeled on rawToJpeg() — performs BGR→RGB swap and feeds Sharp.
   */
  utils.encodeWebpAdvanced = async function(image, config) {
    if (!sharp) {
      throw new Error('Sharp is not available. Install "sharp" in your Node-RED userDir and restart Node-RED.');
    }
    const normalized = utils.validateImageStructure(image, { warn: () => {} });
    if (!normalized)
      throw new Error('Invalid raw image object supplied to encodeWebpAdvanced');

    const colorSpace = normalized.colorSpace;
    const rgb = await utils.toSharpRaw(normalized);

    const sh = sharp(rgb.data, {
      raw: { width: rgb.width, height: rgb.height, channels: rgb.channels }
    });

    if (colorSpace === 'GRAY') sh.toColourspace('b-w');

    const webpOpts = utils.buildWebpOptions(config);
    return sh.webp(webpOpts).toBuffer();
  }

  utils.rawToJpeg = async function (image, quality = CONSTANTS.DEFAULT_JPEG_QUALITY) {
    if (!sharp) {
      throw new Error('Sharp is not available. Install "sharp" in your Node-RED userDir and restart Node-RED.');
    }
    const normalized = utils.validateImageStructure(image, { warn: () => {} });
    if (!normalized)
      throw new Error('Invalid raw image object supplied to rawToJpeg');

    const colorSpace = normalized.colorSpace;
    const rgb = await utils.toSharpRaw(normalized);

    const sh = sharp(rgb.data, {
      raw: { width: rgb.width, height: rgb.height, channels: rgb.channels }
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
   * Error handling with passthrough - always sends output even on error.
   * Use this to ensure flow continues even when processing fails.
   * @param {object} node - Node-RED node instance
   * @param {Error|string} error - The error that occurred
   * @param {object} msg - The message object
   * @param {function} send - The send callback
   * @param {function} done - The done callback
   * @param {string} operation - Operation name for context
   * @param {object} passthroughOptions - Options for passthrough behavior
   * @param {*} passthroughOptions.originalPayload - The original input payload to pass through
   * @param {string} passthroughOptions.outputPath - Where to write output (default: 'payload')
   * @param {string} passthroughOptions.outputType - 'preserve' | 'array' | 'single' | 'empty-array'
   */
  utils.handleNodeErrorWithPassthrough = function(node, error, msg, send, done, operation, passthroughOptions = {}) {
    const {
      originalPayload,
      outputPath = 'payload',
      outputPathType = 'msg',
      outputType = 'preserve',
      context = {}
    } = passthroughOptions;

    const { message: errorMessage, hint, details } = utils.explainError(
      error,
      operation,
      { ...context, msg }
    );
    const errorStack = error instanceof Error ? error.stack : undefined;

    // Build error object
    msg.error = {
      message: errorMessage,
      operation: operation,
      hint: hint,
      details: details,
      timestamp: new Date().toISOString(),
      nodeId: node.id,
      nodeName: node.name || node.type,
      nodeType: node.type
    };

    if (errorStack) {
      msg.error.stack = errorStack;
    }

    // Determine output based on outputType
    let output;
    switch (outputType) {
      case 'preserve':
        output = originalPayload;
        break;
      case 'array':
        output = Array.isArray(originalPayload) ? originalPayload : [originalPayload];
        break;
      case 'single':
        output = Array.isArray(originalPayload) ? originalPayload[0] : originalPayload;
        break;
      case 'empty-array':
        output = [];
        break;
      default:
        output = originalPayload;
    }

    // Set output (optional)
    if (outputPath) {
      utils.setOutputValue(node, msg, outputPath, outputPathType, output);
    }

    // Log error and set status
    const logLine = hint ? `${errorMessage} | Hint: ${hint}` : errorMessage;
    node.warn(logLine);
    node.status({ fill: "red", shape: "ring", text: `Error: ${errorMessage.substring(0, 30)}` });

    // Send message with error info
    send(msg);

    // Call done without error to prevent flow interruption
    if (done) {
      done();
    }
  }

  /**
   * Validation error handling with passthrough - for validation failures before try-catch.
   * @param {object} node - Node-RED node instance
   * @param {string} errorMessage - The validation error message
   * @param {object} msg - The message object
   * @param {function} send - The send callback
   * @param {function} done - The done callback
   * @param {object} passthroughOptions - Same options as handleNodeErrorWithPassthrough
   */
  utils.handleValidationErrorWithPassthrough = function(node, errorMessage, msg, send, done, passthroughOptions = {}) {
    const validation = (typeof errorMessage === 'string')
      ? { message: errorMessage }
      : (errorMessage || {});

    const error = new Error(validation.message || 'Validation error');
    error.validationError = true;

    // Add validationError flag to the options
    const options = {
      ...passthroughOptions,
      context: { ...(passthroughOptions.context || {}), ...(validation.details || {}), hint: validation.hint }
    };

    utils.handleNodeErrorWithPassthrough(
      node, error, msg, send, done,
      'validation',
      options
    );

    // Mark the error object with validation flag after it's created
    if (msg.error) {
      msg.error.validationError = true;
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
    if (!sharp) {
      node.warn('Debug display requires "sharp" but it is not available.');
      return null;
    }
    
    // Validate and set default debug width
    debugWidth = Math.max(1, parseInt(debugWidth) || 200);
    
    try {
      let imageBuffer, formatMessage;
      let actualWidth = debugWidth;
      let actualHeight = debugWidth; // Default fallback
      const resizeOpts = { withoutEnlargement: false, fit: 'inside' };

      if (outputFormat === 'raw') {
        // Raw pixels: resize + JPEG-encode in ONE Sharp pass (previously the
        // full-size image was JPEG-encoded, decoded again and resized).
        const normalized = utils.validateImageStructure(image, { warn: () => {} });
        if (!normalized || Buffer.isBuffer(normalized)) {
          node.warn('Debug display: Invalid image buffer format');
          return null;
        }
        formatMessage = 'jpg default';
        const rgb = await utils.toSharpRaw(normalized);
        try {
          const sh = sharp(rgb.data, {
            raw: { width: rgb.width, height: rgb.height, channels: rgb.channels }
          });
          if (normalized.colorSpace === 'GRAY') sh.toColourspace('b-w');
          const { data, info } = await sh
            .resize(debugWidth, null, resizeOpts)
            .jpeg({ quality: quality || 90 })
            .toBuffer({ resolveWithObject: true });
          imageBuffer = data;
          actualWidth = info.width || debugWidth;
          actualHeight = info.height || debugWidth;
        } catch (resizeError) {
          node.warn(`Debug image resize error: ${resizeError.message}`);
          // Fall back to the full-size JPEG (still encoded off the event loop)
          imageBuffer = await utils.rawToJpeg(normalized, quality || CONSTANTS.DEFAULT_JPEG_QUALITY);
          actualWidth = normalized.width;
          actualHeight = normalized.height;
        }
      } else {
        // Reuse existing encoded buffer ('jpg', 'png', 'webp')
        imageBuffer = Buffer.isBuffer(image) ? image : image.data;
        formatMessage = outputFormat;
        if (!Buffer.isBuffer(imageBuffer)) {
          node.warn('Debug display: Invalid image buffer format');
          return null;
        }
        try {
          // Decode → resize → re-encode (same format) in one pass. JPEG input
          // uses libjpeg shrink-on-load; the output dimensions come from the
          // same pass instead of a second decode via metadata().
          const { data, info } = await sharp(imageBuffer)
            .resize(debugWidth, null, resizeOpts)
            .toBuffer({ resolveWithObject: true });
          imageBuffer = data;
          actualWidth = info.width || debugWidth;
          actualHeight = info.height || debugWidth;
          formatMessage = outputFormat + ' resized';
        } catch (resizeError) {
          node.warn(`Debug image resize error: ${resizeError.message}`);
          // Continue with original image if resize fails; read its header for the size
          try {
            const originalMetadata = await sharp(imageBuffer).metadata();
            actualWidth = originalMetadata.width || debugWidth;
            actualHeight = originalMetadata.height || debugWidth;
          } catch (metadataError) {
            actualWidth = debugWidth;
            actualHeight = debugWidth;
          }
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

  /**
   * Normalizes the performance metric key based on the node's display name.
   * Falls back to the node type when the custom name is missing.
   * @param {object} node - Node-RED node instance
   * @returns {string} sanitized key
   */
  utils.getPerformanceKey = function(node) {
    const base = (node && node.name && String(node.name).trim()) ||
                 (node && node.type) ||
                 'node';
    return String(base)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'node';
  }

  /**
   * Records performance metrics on the outgoing message under
   * msg.performance.rpimage.{nodeNameKey}.
   * @param {object} node - Node-RED node instance
   * @param {object} msg - The message object being emitted
   * @param {object} timings - Timing breakdown { convertMs, encodeMs, taskMs, conversion, task }
   * @param {number|null} totalTime - Total processing time in ms
   */
  utils.recordPerformanceMetrics = function(node, msg, timings = {}, totalTime = null) {
    if (!msg || !node) {
      return;
    }
    
    const key = utils.getPerformanceKey(node);
    const path = `performance.rpimage.${key}`;

    const convertMs = typeof timings.conversion === 'number'
      ? timings.conversion
      : (typeof timings.convertMs === 'number' ? timings.convertMs : 0) +
        (typeof timings.encodeMs === 'number' ? timings.encodeMs : 0);
    const taskMs = typeof timings.task === 'number'
      ? timings.task
      : (typeof timings.taskMs === 'number' ? timings.taskMs : null);
    const totalMs = typeof totalTime === 'number'
      ? totalTime
      : (typeof timings.total === 'number' ? timings.total : null);

    const payload = {
      conversion: Number.isFinite(convertMs) ? convertMs : null,
      task: Number.isFinite(taskMs) ? taskMs : null,
      total: Number.isFinite(totalMs) ? totalMs : null
    };

    try {
      RED.util.setMessageProperty(msg, path, payload, true);
    } catch (err) {
      node.warn(`Failed to record performance metrics: ${err.message}`);
    }
  }

  return utils;
}
