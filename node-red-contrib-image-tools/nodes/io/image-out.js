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
const Cpp = require('../../lib/cpp-bridge.js');

module.exports = function(RED) {
  const NodeUtils = require('../../lib/node-utils.js')(RED);

  // Per-folder cache: file name → mtimeMs. Our own writes and unlinks keep it
  // exact; a full readdir is only repeated every DIR_RESYNC_MS to pick up
  // changes made by other processes.
  const dirCache = new Map();
  const dirSyncedAt = new Map();
  const dirScanInFlight = new Map();
  const DIR_RESYNC_MS = 5000;
  const STAT_CONCURRENCY = 32;   // keep the libuv thread pool free for image work

  // Concurrency-limited async map (results keep input order).
  async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    async function worker() {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
  }

  async function statNames(folderPath, names) {
    const stats = await mapLimit(names, STAT_CONCURRENCY, async (name) => {
      try {
        const st = await fs.stat(path.join(folderPath, name));
        return { name, mtimeMs: st.mtimeMs };
      } catch {
        return null;   // vanished between readdir and stat
      }
    });
    return stats.filter(Boolean);
  }

  // Reconciles the cache with the directory listing (adds unknown files with
  // their mtime, drops files that no longer exist).
  async function syncDirCache(folderPath, map) {
    const entries = await fs.readdir(folderPath, { withFileTypes: true });
    const diskFiles = new Set();
    for (const e of entries) {
      if (e.isFile()) diskFiles.add(e.name);
    }
    for (const name of map.keys()) {
      if (!diskFiles.has(name)) map.delete(name);
    }
    const unknown = [];
    for (const name of diskFiles) {
      if (!map.has(name)) unknown.push(name);
    }
    if (unknown.length > 0) {
      for (const { name, mtimeMs } of await statNames(folderPath, unknown)) map.set(name, mtimeMs);
    }
    dirSyncedAt.set(folderPath, Date.now());
  }

  async function getCachedDir(folderPath) {
    if (dirCache.has(folderPath)) return dirCache.get(folderPath);
    if (dirScanInFlight.has(folderPath)) return dirScanInFlight.get(folderPath);
    const scan = (async () => {
      const map = new Map();
      try {
        await syncDirCache(folderPath, map);
      } catch {
        // folder doesn't exist yet — empty cache is fine
        dirSyncedAt.set(folderPath, Date.now());
      }
      dirCache.set(folderPath, map);
      dirScanInFlight.delete(folderPath);
      return map;
    })();
    dirScanInFlight.set(folderPath, scan);
    return scan;
  }

  function ImageOutNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    // Initialize node state
    node.active = config.active !== false;
    const diskThresholdPct = parseInt(config.diskThreshold, 10);
    const diskThreshold = (Number.isInteger(diskThresholdPct) && diskThresholdPct > 0 && diskThresholdPct <= 100)
      ? diskThresholdPct / 100
      : 0;
    let diskCheckErrorLogged = false;

    updateNodeStatus();

    function updateNodeStatus() {
      if (!node.active) {
        node.status({ fill: "grey", shape: "dot", text: "inactive" });
      } else {
        node.status({});
      }
    }

    // Image encoding helper — shared by single and multiple modes
    async function encodeImage(image, { format, quality, pngCompression, webpLossless, webpSmartSubsample, hasWebpEffort, webpEffort }) {
      // Encoded buffer input (JPEG, PNG, WebP)
      if (Buffer.isBuffer(image) && !image.width && !image.height) {
        let inputFormat;
        try {
          const metadata = await sharp(image).metadata();
          inputFormat = metadata.format;
        } catch {
          inputFormat = null;
        }

        const sameFormat = inputFormat === format || (inputFormat === 'jpeg' && format === 'jpg');
        const needsWebpReencode = format === 'webp' && (webpLossless || hasWebpEffort);

        if (sameFormat && !needsWebpReencode) {
          return image;
        }

        const inst = sharp(image);
        switch (format) {
          case 'jpg': return inst.jpeg({ quality }).toBuffer();
          case 'png': return inst.png({ compressionLevel: pngCompression }).toBuffer();
          case 'webp': {
            const wo = { quality };
            if (webpLossless) wo.lossless = true;
            if (!webpLossless && webpSmartSubsample) wo.smartSubsample = true;
            if (hasWebpEffort) wo.effort = webpEffort;
            return inst.webp(wo).toBuffer();
          }
          case 'bmp': throw new Error('BMP output requires raw image data, not an encoded buffer');
          default: throw new Error(`Unsupported format: ${format}`);
        }
      }

      // Raw image data
      const validated = NodeUtils.validateImageStructure(image, node);
      if (!validated) throw new Error("Invalid image structure");

      const colorSpace = validated.colorSpace;

      // BMP: encoded by the native engine on the thread pool (Sharp cannot write BMP)
      if (format === 'bmp') {
        const { image: bmp } = await Cpp.encode(validated, 'bmp');
        return bmp;
      }

      // BGR/BGRA → RGB/RGBA for Sharp (native, off the event loop)
      const rgb = await NodeUtils.toSharpRaw(validated);

      const inst = sharp(rgb.data, {
        raw: { width: rgb.width, height: rgb.height, channels: rgb.channels }
      });
      if (colorSpace === 'GRAY') inst.toColourspace('b-w');

      switch (format) {
        case 'jpg': return inst.jpeg({ quality }).toBuffer();
        case 'png': return inst.png({ compressionLevel: pngCompression }).toBuffer();
        case 'webp': {
          const wo = { quality };
          if (webpLossless) wo.lossless = true;
          if (!webpLossless && webpSmartSubsample) wo.smartSubsample = true;
          if (hasWebpEffort) wo.effort = webpEffort;
          return inst.webp(wo).toBuffer();
        }
        default: throw new Error(`Unsupported format: ${format}`);
      }
    }

    node.on('input', async function(msg, send, done) {
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
                if (err) reject(err);
                else resolve(result);
              });
            } catch (err) {
              reject(err);
            }
          });
        };

        if (!sharp) {
          throw new Error('Sharp is not available. Install "sharp" in your Node-RED userDir and restart Node-RED.');
        }

        // Shared format config
        let format = (config.outputFormat || 'jpg').toLowerCase();
        if (!['jpg', 'png', 'webp', 'bmp'].includes(format)) format = 'jpg';
        const quality = parseInt(config.outputQuality, 10) || 90;
        const pngCompression = Math.max(0, Math.min(9, parseInt(config.pngCompression, 10) || 0));
        const webpLossless = config.webpLossless === true || config.webpLossless === 'true';
        const webpSmartSubsample = config.webpSmartSubsample === true || config.webpSmartSubsample === 'true';
        const parsedEffort = parseInt(config.webpEffort, 10);
        const hasWebpEffort = Number.isInteger(parsedEffort);
        const webpEffort = hasWebpEffort ? Math.min(6, Math.max(0, parsedEffort)) : null;
        const encodeOpts = { format, quality, pngCompression, webpLossless, webpSmartSubsample, hasWebpEffort, webpEffort };

        // Shared max images
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
              if (Number.isNaN(numericMax)) throw new Error(`Value "${resolvedMax}" is not a valid integer.`);
              if (numericMax < 0) throw new Error('Value must be zero or a positive integer.');
              maxImages = numericMax;
            }
          } catch (err) {
            throw new Error(`Unable to resolve max images: ${err.message}`);
          }
        }

        // ===== MULTIPLE MODE =====
        if (config.mode === 'multiple') {
          node.status({ fill: 'blue', shape: 'dot', text: 'saving...' });

          const saveConfigType = config.saveConfigType || 'msg';
          let saveConfig = await evaluateProperty(config.saveConfig || 'payload', saveConfigType);
          if (!Array.isArray(saveConfig)) {
            if (saveConfig && typeof saveConfig === 'object') {
              saveConfig = [saveConfig];
            } else {
              throw new Error('Input must resolve to an array or object.');
            }
          }
          if (saveConfig.length === 0) {
            node.warn('Empty array — nothing to save.');
            node.status({ fill: 'yellow', shape: 'ring', text: 'empty array' });
            if (done) done();
            return;
          }

          const imageField = config.imageField || 'bitmap';
          const filenameField = config.filenameField || 'filename';
          const filenameFieldType = config.filenameFieldType || 'item';
          const outputDirField = config.outputDirField || 'outputDir';
          const outputDirFieldType = config.outputDirFieldType || 'item';

          let sharedFilename = null;
          if (filenameFieldType !== 'item') {
            sharedFilename = await evaluateProperty(filenameField, filenameFieldType);
          }
          let sharedOutputDir = null;
          if (outputDirFieldType !== 'item') {
            sharedOutputDir = await evaluateProperty(outputDirField, outputDirFieldType);
          }

          const results = [];
          let skipped = 0;

          for (let idx = 0; idx < saveConfig.length; idx++) {
            try {
              const item = saveConfig[idx];
              if (!item || typeof item !== 'object') {
                node.warn(`Item ${idx}: not an object, skipping.`);
                skipped++;
                continue;
              }

              const image = item[imageField];
              if (!image) {
                node.warn(`Item ${idx}: no image at "${imageField}", skipping.`);
                skipped++;
                continue;
              }

              // Resolve folder
              const folderPath = String(
                outputDirFieldType === 'item'
                  ? (item[outputDirField] ?? '')
                  : (sharedOutputDir ?? '')
              ).trim();
              if (!folderPath) {
                node.warn(`Item ${idx}: empty folder path, skipping.`);
                skipped++;
                continue;
              }
              await fs.mkdir(folderPath, { recursive: true });

              // Disk check
              const diskInfo = diskThreshold > 0 ? await getDiskUsageInfo(folderPath) : null;
              if (diskInfo && diskInfo.usedRatio >= diskThreshold) {
                const pct = (diskInfo.usedRatio * 100).toFixed(1);
                node.warn(`Storage ${pct}% full, skipping remaining items.`);
                node.status({ fill: 'yellow', shape: 'ring', text: `disk ${pct}% full` });
                break;
              }

              // Resolve filename
              const filenameRaw = String(
                filenameFieldType === 'item'
                  ? (item[filenameField] ?? '')
                  : (sharedFilename ?? '')
              ).trim();

              // Determine per-item format & extension (filename ext can override)
              let itemFormat = format;
              let fileExtension = format === 'jpg' ? 'jpg' : format;
              let baseFilename;

              if (filenameRaw) {
                if (/[\\/]/.test(filenameRaw)) {
                  node.warn(`Item ${idx}: filename contains path separators, skipping.`);
                  skipped++;
                  continue;
                }
                const parsed = path.parse(filenameRaw);
                if (parsed.ext) {
                  const extLower = parsed.ext.slice(1).toLowerCase();
                  if (['jpg', 'jpeg', 'png', 'webp', 'bmp'].includes(extLower)) {
                    fileExtension = parsed.ext.slice(1);
                    itemFormat = extLower === 'jpeg' ? 'jpg' : extLower;
                  }
                  baseFilename = parsed.name;
                } else {
                  baseFilename = parsed.base;
                }
              } else {
                const ts = new Date()
                  .toISOString()
                  .replace(/[-:]/g, '')
                  .replace(/\.(\d{3})Z$/, '-$1Z')
                  .replace('T', '_');
                baseFilename = `image_${ts}`;
              }

              let filename = `${baseFilename}.${fileExtension}`;
              let filePath = path.join(folderPath, filename);

              // Overwrite protection
              if (config.overwriteProtection !== false) {
                const dirMap = await getCachedDir(folderPath);
                let counter = 2;
                while (dirMap.has(filename)) {
                  filename = `${baseFilename}_${counter}.${fileExtension}`;
                  filePath = path.join(folderPath, filename);
                  counter++;
                  if (counter > 1000) throw new Error('Too many file variations');
                }
              }

              // Encode & write
              const itemEncodeOpts = itemFormat !== format
                ? { ...encodeOpts, format: itemFormat }
                : encodeOpts;
              const outputBuffer = await encodeImage(image, itemEncodeOpts);
              await fs.writeFile(filePath, outputBuffer);
              dirCache.get(folderPath)?.set(filename, Date.now());

              if (maxImages > 0) {
                try {
                  await enforceMaxImages(folderPath, maxImages);
                } catch (policyErr) {
                  node.warn(`Max images enforcement failed: ${policyErr.message}`);
                }
              }

              results.push({ path: filePath, filename, format: itemFormat, extension: fileExtension });
            } catch (itemErr) {
              node.warn(`Item ${idx}: ${itemErr.message}`);
              skipped++;
            }
          }

          if (results.length === 0) {
            throw new Error(`All ${saveConfig.length} items failed.`);
          }

          const elapsedMs = Date.now() - startTime;
          const statusText = skipped > 0
            ? `saved ${results.length}/${saveConfig.length} files (${elapsedMs}ms)`
            : `saved ${results.length} files (${elapsedMs}ms)`;
          node.status({ fill: 'green', shape: 'dot', text: statusText });

          if (done) done();
          return;
        }

        // ===== SINGLE MODE =====

        // Resolve folder path
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

        // Retrieve input image
        const inputPath = config.inputPath || 'payload';
        const inputPathType = config.inputPathType || 'msg';
        let image;
        if (inputPathType === 'msg') {
          const { value, error } = NodeUtils.safeGetMessageProperty(msg, inputPath);
          if (error) throw new Error(`Invalid inputPath "${inputPath}": ${error.message}`);
          image = value;
        } else if (inputPathType === 'flow') {
          image = node.context().flow.get(inputPath);
        } else if (inputPathType === 'global') {
          image = node.context().global.get(inputPath);
        }
        if (!image) throw new Error('No image data found at specified input path');

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
              if (trimmed) resolvedFullFilename = trimmed;
            }
          } catch (err) {
            throw new Error(`Unable to resolve full filename: ${err.message}`);
          }
        }

        // Resolve prefix
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

        // Build filename
        let fileExtension = format === 'jpg' ? 'jpg' : format;
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
          const dirMap = await getCachedDir(folderPath);
          let counter = 2;
          while (dirMap.has(filename)) {
            filename = `${baseFilename}_${counter}.${fileExtension}`;
            filePath = path.join(folderPath, filename);
            counter += 1;
            if (counter > 1000) throw new Error('Too many file variations exist');
          }
        }

        const diskInfo = diskThreshold > 0 ? await getDiskUsageInfo(folderPath) : null;
        if (diskInfo && diskInfo.usedRatio >= diskThreshold) {
          const usedPercent = (diskInfo.usedRatio * 100).toFixed(1);
          node.warn(`Storage at "${folderPath}" is ${usedPercent}% full. Skipping image save to avoid exhausting disk space.`);
          node.status({ fill: "yellow", shape: "ring", text: `disk ${usedPercent}% full` });
          if (done) done();
          return;
        }

        // Encode image (format may have been overridden by filename extension)
        const outputBuffer = await encodeImage(image, { ...encodeOpts, format });

        // Write file to disk
        await fs.writeFile(filePath, outputBuffer);
        dirCache.get(folderPath)?.set(filename, Date.now());

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
              outputBuffer, format, quality, node, true, config.debugWidth || 200
            );
            if (debugResult) {
              const statusText = renameOccurred
                ? `saved: ${filename} (avoided overwrite)`
                : `saved: ${filename}`;
              node.status({ fill: "green", shape: "dot", text: statusText + ` | ${format} debug` });
            }
          } catch (debugError) {
            node.warn(`Debug display error: ${debugError.message}`);
          }
        } else {
          const elapsedMs = Date.now() - startTime;
          const statusText = renameOccurred
            ? `saved: ${filename} (${elapsedMs}ms, avoided overwrite)`
            : `saved: ${filename} (${elapsedMs}ms)`;
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
        if (hint) node.warn(`Hint: ${hint}`);
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

    async function enforceMaxImages(folderPath, maxCount) {
      if (maxCount <= 0) return;

      // The cache is authoritative for our own writes; re-list the directory
      // only every DIR_RESYNC_MS (instead of on every message) to catch files
      // added or removed by other processes.
      const cachedMap = await getCachedDir(folderPath);
      if (Date.now() - (dirSyncedAt.get(folderPath) || 0) >= DIR_RESYNC_MS) {
        await syncDirCache(folderPath, cachedMap);
      }

      if (cachedMap.size <= maxCount) return;

      const sorted = Array.from(cachedMap, ([name, mtimeMs]) => ({ name, mtimeMs }));
      sorted.sort((a, b) => a.mtimeMs - b.mtimeMs);

      const toRemove = sorted.slice(0, sorted.length - maxCount);
      await mapLimit(toRemove, STAT_CONCURRENCY, async ({ name }) => {
        try {
          await fs.unlink(path.join(folderPath, name));
        } catch (err) {
          if (err.code !== 'ENOENT') throw err;
        }
        cachedMap.delete(name);
      });
    }

    // Handle cleanup
    node.on('close', function() {
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
        desiredState = !node.active;
      }

      node.active = desiredState;

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
