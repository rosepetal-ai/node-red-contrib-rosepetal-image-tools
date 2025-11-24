/**
 * @file Generic filesystem sink that can write JSON, images, text, or binary data.
 * Designed to accept raw image objects, encoded buffers, or plain JS values.
 */
const fs = require('fs').promises;
const path = require('path');
const sharp = require('sharp');
const JSON_WARN_BYTES = 5 * 1024 * 1024; // warn when JSON output is larger than 5MB

module.exports = function (RED) {
  const NodeUtils = require('../../lib/node-utils.js')(RED);

  function SaveFileNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const diskWarnState = { logged: false };

    node.on('input', async (msg, send, done) => {
      const started = Date.now();
      node.status({ fill: 'blue', shape: 'dot', text: 'saving...' });

      try {
        const evaluateProperty = (value, type, fallback = 'str') =>
          new Promise((resolve, reject) => {
            const actualType = type || fallback;
            try {
              RED.util.evaluateNodeProperty(value, actualType, node, msg, (err, res) => {
                if (err) reject(err);
                else resolve(res);
              });
            } catch (err) {
              reject(err);
            }
          });

        // Resolve paths and inputs
        const folderPathType = config.folderPathType || 'str';
        const folderPathValue = await evaluateProperty(config.folderPath, folderPathType);
        const folderPath = String(folderPathValue ?? '').trim();
        if (!folderPath) {
          throw new Error('Folder path is not configured or resolved.');
        }
        await fs.mkdir(folderPath, { recursive: true });

        const inputPath = config.inputPath || 'payload';
        const inputPathType = config.inputPathType || 'msg';
        let incoming;
        if (inputPathType === 'msg') {
          incoming = RED.util.getMessageProperty(msg, inputPath);
        } else if (inputPathType === 'flow') {
          incoming = node.context().flow.get(inputPath);
        } else if (inputPathType === 'global') {
          incoming = node.context().global.get(inputPath);
        }
        if (incoming === undefined) {
          throw new Error('No data found at configured input path.');
        }

        // Resolve file name
        const filenameType = config.filenameType || 'str';
        const filenameValue = await evaluateProperty(config.filename, filenameType);
        const filenameRaw = filenameValue !== undefined && filenameValue !== null
          ? String(filenameValue).trim()
          : '';
        if (/[\\/]/.test(filenameRaw)) {
          throw new Error('Filename must not contain path separators.');
        }
        const parsedName = path.parse(filenameRaw);
        let baseName = parsedName.name || '';
        let extFromName = parsedName.ext ? parsedName.ext.replace(/^\./, '') : '';

        // Determine file type and format
        const configType = String(config.fileType || 'auto').toLowerCase();
        let imageFormat = String(config.imageFormat || 'jpg').toLowerCase();
        const extInfo = mapExtension(extFromName);

        let fileType = configType;
        if (fileType === 'auto' && extInfo?.type) {
          fileType = extInfo.type;
          if (extInfo.format) {
            imageFormat = extInfo.format;
          }
        }

        const inferred = fileType === 'auto'
          ? await inferFileType(incoming, extInfo)
          : { type: fileType, format: imageFormat };

        fileType = inferred.type;
        if (fileType === 'image' && inferred.format) {
          imageFormat = inferred.format;
        }
        if (fileType === 'image' && extInfo?.format) {
          imageFormat = extInfo.format;
        }

        if (!['image', 'json', 'text', 'binary'].includes(fileType)) {
          throw new Error(`Unsupported file type: ${fileType}`);
        }

        // Finalize extension and name
        let extension = extFromName || defaultExtension(fileType, imageFormat);
        if (!extension) {
          throw new Error('Unable to determine file extension.');
        }
        if (!baseName) {
          baseName = defaultBaseName(fileType);
        }
        let filename = `${baseName}.${extension}`;
        const originalFilename = filename;
        let filePath = path.join(folderPath, filename);

        const overwriteEnabled = String(config.overwriteProtection) !== 'false';
        if (overwriteEnabled) {
          let counter = 2;
          while (await fileExists(filePath)) {
            filename = `${baseName}_${counter}.${extension}`;
            filePath = path.join(folderPath, filename);
            counter += 1;
            if (counter > 1000) {
              throw new Error('Too many file variations exist in target folder.');
            }
          }
        }

        // Check disk space (skip if 90%+ used)
        const diskInfo = await getDiskUsageInfo(folderPath, node, diskWarnState);
        if (diskInfo && diskInfo.usedRatio >= 0.9) {
          const usedPercent = (diskInfo.usedRatio * 100).toFixed(1);
          node.warn(`Storage at "${folderPath}" is ${usedPercent}% full. Skipping save to avoid exhausting disk space.`);
          node.status({ fill: 'yellow', shape: 'ring', text: `disk ${usedPercent}% full` });
          done && done();
          return;
        }

        // Prepare data to write
        const quality = parseInt(config.imageQuality, 10) || 90;
        const pngOptimize = config.pngOptimize === true || config.pngOptimize === 'true';
        const jsonIndent = Number.isInteger(parseInt(config.jsonIndent, 10))
          ? parseInt(config.jsonIndent, 10)
          : 2;

        let payloadToWrite;
        let isText = false;

        if (fileType === 'image') {
          payloadToWrite = await toImageBuffer(incoming, imageFormat, quality, pngOptimize, NodeUtils, node);
        } else if (fileType === 'json') {
          if (typeof incoming === 'string') {
            try {
              // Keep valid JSON strings as-is
              JSON.parse(incoming);
              payloadToWrite = incoming;
            } catch {
              payloadToWrite = JSON.stringify(incoming, null, jsonIndent);
            }
          } else {
            payloadToWrite = JSON.stringify(incoming, null, jsonIndent);
          }
          isText = true;
        } else if (fileType === 'text') {
          payloadToWrite = incoming === undefined || incoming === null ? '' : String(incoming);
          isText = true;
        } else {
          payloadToWrite = await toBinary(incoming);
        }

        if (isText) {
          await fs.writeFile(filePath, payloadToWrite, 'utf8');
        } else {
          await fs.writeFile(filePath, payloadToWrite);
        }

        const sizeBytes = isText
          ? Buffer.byteLength(payloadToWrite, 'utf8')
          : payloadToWrite.length;

        if (fileType === 'json' && sizeBytes >= JSON_WARN_BYTES) {
          const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(1);
          node.warn(`JSON output is large (${sizeMB} MB); this may impact the event loop and memory usage.`);
        }

        const resultInfo = {
          path: filePath,
          filename,
          type: fileType,
          extension,
          sizeBytes
        };
        if (fileType === 'image') {
          resultInfo.format = imageFormat;
        }

        // Optionally attach result info for downstream nodes
        const outputPath = config.outputPath || 'savedFile';
        const outputPathType = config.outputPathType || 'msg';
        try {
          if (outputPathType === 'msg') {
            RED.util.setMessageProperty(msg, outputPath, resultInfo, true);
          } else if (outputPathType === 'flow') {
            node.context().flow.set(outputPath, resultInfo);
          } else if (outputPathType === 'global') {
            node.context().global.set(outputPath, resultInfo);
          }
        } catch (setErr) {
          node.warn(`Unable to store output metadata: ${setErr.message}`);
        }

        const elapsed = Date.now() - started;
        const renameOccurred = overwriteEnabled && filename !== originalFilename;
        const statusSuffix = renameOccurred ? ' (avoided overwrite)' : '';
        node.status({
          fill: 'green',
          shape: 'dot',
          text: `saved ${filename}${statusSuffix} (${elapsed}ms)`
        });

        // Record basic performance metric for consistency across nodes
        NodeUtils.recordPerformanceMetrics(node, msg, { taskMs: elapsed }, elapsed);

        send(msg);
        done && done();
      } catch (err) {
        node.status({ fill: 'red', shape: 'ring', text: 'Error' });
        node.error(err.message, msg);
        done && done(err);
      }
    });
  }

  RED.nodes.registerType('save-file', SaveFileNode);
};

// Helpers
function mapExtension(ext) {
  if (!ext) return null;
  const lower = ext.toLowerCase();
  if (lower === 'jpg' || lower === 'jpeg') return { type: 'image', format: 'jpg' };
  if (lower === 'png') return { type: 'image', format: 'png' };
  if (lower === 'webp') return { type: 'image', format: 'webp' };
  if (lower === 'json') return { type: 'json' };
  if (lower === 'txt') return { type: 'text' };
  if (lower === 'bin' || lower === 'dat') return { type: 'binary' };
  return null;
}

function defaultExtension(type, imageFormat) {
  if (type === 'image') return imageFormat || 'jpg';
  if (type === 'json') return 'json';
  if (type === 'text') return 'txt';
  if (type === 'binary') return 'bin';
  return '';
}

function defaultBaseName(type) {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')
    .replace('T', '_');
  switch (type) {
    case 'image': return `image_${timestamp}`;
    case 'json': return `data_${timestamp}`;
    case 'text': return `text_${timestamp}`;
    default: return `file_${timestamp}`;
  }
}

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function inferFileType(value, extInfo) {
  if (extInfo?.type) {
    return { type: extInfo.type, format: extInfo.format };
  }

  if (value && typeof value === 'object') {
    if (Buffer.isBuffer(value)) {
      try {
        const meta = await sharp(value).metadata();
        if (meta?.format) {
          const fmt = normalizeSharpFormat(meta.format);
          if (fmt) return { type: 'image', format: fmt };
        }
      } catch {
        // Not an image buffer
      }
      return { type: 'binary' };
    }

    if (isRawImageLike(value)) {
      return { type: 'image' };
    }

    return { type: 'json' };
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
        (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      return { type: 'json' };
    }
    return { type: 'text' };
  }

  return { type: 'binary' };
}

function normalizeSharpFormat(fmt) {
  if (!fmt) return null;
  if (fmt === 'jpeg' || fmt === 'jpg') return 'jpg';
  if (fmt === 'png') return 'png';
  if (fmt === 'webp') return 'webp';
  return null;
}

function isRawImageLike(obj) {
  return obj &&
    typeof obj === 'object' &&
    !Buffer.isBuffer(obj) &&
    Object.prototype.hasOwnProperty.call(obj, 'data') &&
    Object.prototype.hasOwnProperty.call(obj, 'width') &&
    Object.prototype.hasOwnProperty.call(obj, 'height');
}

async function toBinary(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value && typeof value === 'object' && Buffer.isBuffer(value.data)) {
    return Buffer.from(value.data);
  }
  if (typeof value === 'string') {
    return Buffer.from(value, 'utf8');
  }
  return Buffer.from(JSON.stringify(value ?? ''), 'utf8');
}

async function toImageBuffer(imageValue, format, quality, pngOptimize, NodeUtils, node) {
  // Encoded buffer path
  if (Buffer.isBuffer(imageValue) && !(imageValue.width && imageValue.height)) {
    let inputFormat;
    try {
      const metadata = await sharp(imageValue).metadata();
      inputFormat = metadata.format;
    } catch {
      inputFormat = null;
    }

    if (inputFormat && (normalizeSharpFormat(inputFormat) === format)) {
      return imageValue;
    }

    const sharpInstance = sharp(imageValue);
    return encodeSharp(sharpInstance, format, quality, pngOptimize);
  }

  // Raw image path (uses validator for clear errors)
  const validated = NodeUtils.validateImageStructure(imageValue, node);
  if (!validated) {
    throw new Error('Invalid image structure.');
  }

  const colorSpace = validated.colorSpace;
  const channels = validated.channels;
  let data = validated.data;

  if (colorSpace === 'BGR' || colorSpace === 'BGRA') {
    data = Buffer.from(data);
    for (let i = 0; i < data.length; i += channels) {
      const t = data[i];
      data[i] = data[i + 2];
      data[i + 2] = t;
    }
  }

  let sharpInstance = sharp(data, {
    raw: {
      width: validated.width,
      height: validated.height,
      channels: channels
    }
  });

  if (colorSpace === 'GRAY') {
    sharpInstance = sharpInstance.toColourspace('b-w');
  }

  return encodeSharp(sharpInstance, format, quality, pngOptimize);
}

function encodeSharp(sharpInstance, format, quality, pngOptimize) {
  if (format === 'png') {
    const pngOptions = pngOptimize
      ? { compressionLevel: 9, palette: true }
      : { compressionLevel: 6 };
    return sharpInstance.png(pngOptions).toBuffer();
  }
  if (format === 'webp') {
    return sharpInstance.webp({ quality }).toBuffer();
  }
  return sharpInstance.jpeg({ quality }).toBuffer();
}

async function getDiskUsageInfo(targetPath, node, warnState) {
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
    if (!warnState.logged) {
      node.warn(`Disk usage check failed for "${targetPath}": ${err.message}`);
      warnState.logged = true;
    }
    return null;
  }
}
