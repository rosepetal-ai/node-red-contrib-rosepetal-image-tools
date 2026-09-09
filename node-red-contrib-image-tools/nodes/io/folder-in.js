/**
 * @file Node.js logic for the Folder-In node with interval-based image emission.
 * Scans a folder for images and emits them one by one at configurable intervals.
 * Features a toggle button (like inject node) to start/stop emission.
 * @author Rosepetal
 */

const { performance } = require('perf_hooks');
let sharp;
try {
  sharp = require('sharp');
} catch (err) {
  sharp = null;
}
const fs = require('fs').promises;
const path = require('path');
const BmpDecode = require('../../lib/bmp-decode.js');

module.exports = function(RED) {
  const NodeUtils = require('../../lib/node-utils.js')(RED);

  function FolderInNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    // Node state
    let running = false;
    let starting = false;
    let sleepTimer = null;     // pending setTimeout of the emission loop
    let sleepResolve = null;   // resolver of the pending sleep (so stop() can wake the loop)
    let imageFiles = [];
    let currentIndex = 0;
    let folderPath = null;

    /**
     * Detects the container format from the file header so the debug preview
     * can be produced straight from the encoded file (Sharp shrink-on-load)
     * instead of re-encoding the decoded raw pixels.
     */
    function sniffEncodedFormat(buf) {
      if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
      if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'jpg';
      if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'png';
      if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
      return null;
    }

    // Supported image extensions
    const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif', '.tiff'];

    /**
     * Scans the configured folder for image files
     */
    async function scanFolder() {
      try {
        // Resolve folder path
        if (config.folderPathType === 'msg' || config.folderPathType === 'flow' || config.folderPathType === 'global') {
          // For dynamic paths, we need a message context - skip scan if not available
          node.warn("Dynamic folder paths require message input to resolve");
          return [];
        } else {
          folderPath = config.folderPath;
        }

        if (!folderPath) {
          node.warn("Folder path is not configured");
          return [];
        }

        // Read directory contents
        const files = await fs.readdir(folderPath);

        // Filter for image files and sort alphabetically
        const images = files
          .filter(file => {
            const ext = path.extname(file).toLowerCase();
            return IMAGE_EXTENSIONS.includes(ext);
          })
          .sort()
          .map(file => path.join(folderPath, file));

        if (images.length === 0) {
          node.warn(`No image files found in folder: ${folderPath}`);
        }

        return images;
      } catch (err) {
        node.error(`Error scanning folder: ${err.message}`);
        return [];
      }
    }

    /**
     * Loads and emits the next image
     */
    async function emitNextImage() {
      if (imageFiles.length === 0) {
        node.warn("No images to emit");
        stopEmission();
        return;
      }

      try {
        if (!sharp) {
          node.error('Folder-In requires "sharp" but it is not available. Install "sharp" and restart Node-RED.');
          stopEmission();
          return;
        }

        const startTime = performance.now();
        const filePath = imageFiles[currentIndex];
        const fileName = path.basename(filePath);

        node.status({ fill: "blue", shape: "dot", text: `Loading ${fileName}...` });

        // Check file accessibility
        await fs.access(filePath, fs.constants.R_OK);

        // Read encoded file once so we can reuse it for both decoding and debug preview
        const fileBuffer = await fs.readFile(filePath);

        // Decode: BMP natively (Sharp cannot read it), everything else via Sharp
        const decodeStart = performance.now();
        let data, info;
        if (BmpDecode.isBmp(fileBuffer)) {
          const decoded = await BmpDecode.decodeBmp(fileBuffer);
          data = decoded.data;
          info = { width: decoded.width, height: decoded.height, channels: decoded.channels };
        } else {
          ({ data, info } = await sharp(fileBuffer).raw().toBuffer({ resolveWithObject: true }));
        }
        const decodeMs = performance.now() - decodeStart;

        // Determine colorSpace from Sharp info
        let colorSpace;
        switch (info.channels) {
          case 1: colorSpace = 'GRAY'; break;
          case 3: colorSpace = 'RGB'; break;
          case 4: colorSpace = 'RGBA'; break;
          default: throw new Error(`Unsupported number of channels: ${info.channels}`);
        }

        // Create complete image structure
        const outputImageObject = {
          data: data,
          width: info.width,
          height: info.height,
          channels: info.channels,
          colorSpace: colorSpace,
          dtype: "uint8"
        };

        // Create new message
        const msg = {};
        const outputPath = config.outputPath || "payload";
        const outputPathType = config.outputPathType || "msg";

        if (outputPathType === 'msg') {
          RED.util.setMessageProperty(msg, outputPath, outputImageObject);
        } else if (outputPathType === 'flow') {
          node.context().flow.set(outputPath, outputImageObject);
        } else if (outputPathType === 'global') {
          node.context().global.set(outputPath, outputImageObject);
        }

        // Add metadata to message
        msg._folderIn = {
          fileName: fileName,
          filePath: filePath,
          index: currentIndex,
          total: imageFiles.length
        };

        // Debug image display if enabled
        let debugFormat = null;
        const debugEnabled = config.debugEnabled === true || config.debugEnabled === 'true';
        if (debugEnabled) {
          try {
            let debugWidthRaw = config.debugWidth;
            const debugWidthType = config.debugWidthType || 'num';

            try {
              debugWidthRaw = NodeUtils.resolveDimension(
                node,
                debugWidthType,
                config.debugWidth,
                msg
              );
            } catch (resolveErr) {
              node.warn(`Debug width resolution failed (${resolveErr.message}); using default 200`);
            }

            const debugWidth = Math.max(1, parseInt(debugWidthRaw, 10) || 200);

            // Prefer the original encoded file when its format is supported by
            // the editor preview: Sharp then decodes at reduced size directly.
            let debugSource = outputImageObject;
            let debugFormatHint = 'raw';
            const encodedFormat = sniffEncodedFormat(fileBuffer);
            if (encodedFormat) {
              debugSource = fileBuffer;
              debugFormatHint = encodedFormat;
            }

            const debugResult = await NodeUtils.debugImageDisplay(
              debugSource,
              debugFormatHint,
              90,
              node,
              debugEnabled,
              debugWidth
            );

            if (debugResult) {
              debugFormat = debugResult.formatMessage;
              msg._folderIn.debug = debugFormat;
            }
          } catch (debugError) {
            node.warn(`Debug display error: ${debugError.message}`);
          }
        }

        // Update status
        const statusParts = [`${currentIndex + 1}/${imageFiles.length}: ${fileName}`];
        if (debugFormat) {
          statusParts.push(debugFormat);
        }
        node.status({ fill: "green", shape: "dot", text: statusParts.join(' | ') });

        const totalTime = performance.now() - startTime;
        const taskMs = Math.max(0, totalTime - decodeMs);
        NodeUtils.recordPerformanceMetrics(node, msg, {
          convertMs: decodeMs,
          taskMs: taskMs
        }, totalTime);

        // Stopped while this image was being decoded: discard it
        if (!running) return;

        // Send message
        node.send(msg);

        // Advance to next image
        currentIndex++;

        // Handle loop vs one-shot mode
        if (currentIndex >= imageFiles.length) {
          if (config.mode === 'loop') {
            // Loop mode: restart from beginning
            currentIndex = 0;
          } else {
            // One-shot mode: stop emission
            stopEmission();
            node.status({ fill: "grey", shape: "ring", text: "Completed all images" });
          }
        }

      } catch (err) {
        node.error(`Error loading image: ${err.message}`);
        node.status({ fill: "red", shape: "ring", text: `Error: ${err.message}` });
      }
    }

    /** Async sleep that stopEmission() can interrupt. */
    function sleep(ms) {
      return new Promise((resolve) => {
        sleepResolve = resolve;
        sleepTimer = setTimeout(() => {
          sleepTimer = null;
          sleepResolve = null;
          resolve();
        }, ms);
      });
    }

    function wakeLoop() {
      if (sleepTimer) {
        clearTimeout(sleepTimer);
        sleepTimer = null;
      }
      if (sleepResolve) {
        const resolve = sleepResolve;
        sleepResolve = null;
        resolve();
      }
    }

    /**
     * Emission loop. Unlike setInterval, the next emission is scheduled only
     * after the previous one has finished, so a slow decode can never overlap
     * with the next tick; the cadence is kept whenever decoding is faster than
     * the interval.
     */
    async function runEmissionLoop(intervalMs) {
      while (running) {
        const started = performance.now();
        await emitNextImage();
        if (!running) break;
        const delay = Math.max(0, intervalMs - (performance.now() - started));
        await sleep(delay);
      }
    }

    /**
     * Starts the interval-based emission
     */
    async function startEmission() {
      if (running || starting) return;
      starting = true;

      let intervalMs;
      try {
        node.status({ fill: "yellow", shape: "dot", text: "Scanning folder..." });

        // Scan folder for images
        imageFiles = await scanFolder();

        if (imageFiles.length === 0) {
          node.status({ fill: "red", shape: "ring", text: "No images found" });
          return;
        }

        // Reset index
        currentIndex = 0;
        running = true;

        // Get interval value
        intervalMs = config.interval || 1000;
        if (config.intervalType === 'msg' || config.intervalType === 'flow' || config.intervalType === 'global') {
          // For dynamic intervals, use default for now - can be enhanced with message input
          intervalMs = config.interval || 1000;
        }
        intervalMs = parseInt(intervalMs);
        if (!Number.isFinite(intervalMs) || intervalMs < 0) intervalMs = 1000;

        node.status({ fill: "green", shape: "dot", text: `Started (${imageFiles.length} images, ${intervalMs}ms)` });
      } finally {
        starting = false;
      }

      // Emits the first image immediately, then one every intervalMs
      runEmissionLoop(intervalMs).catch((err) => {
        node.error(`Emission loop failed: ${err.message}`);
        stopEmission();
      });
    }

    /**
     * Stops the emission loop
     */
    function stopEmission() {
      if (!running) return;

      running = false;
      wakeLoop();

      node.status({ fill: "grey", shape: "ring", text: "Stopped" });
    }

    /**
     * Toggles emission on/off
     */
    function toggleEmission() {
      if (running) {
        stopEmission();
      } else {
        startEmission();
      }
    }

    // HTTP endpoint for button clicks (like inject node)
    RED.httpAdmin.post("/folder-in/:id", RED.auth.needsPermission('folder-in.write'), function(req, res) {
      const nodeId = req.params.id;
      const targetNode = RED.nodes.getNode(nodeId);

      if (targetNode) {
        try {
          targetNode.toggleEmission();
          res.sendStatus(200);
        } catch(err) {
          res.sendStatus(500);
          targetNode.error("Failed to toggle: " + err.toString());
        }
      } else {
        res.sendStatus(404);
      }
    });

    // Make toggle function accessible to HTTP endpoint
    node.toggleEmission = toggleEmission;

    // Cleanup on node close
    node.on('close', function() {
      stopEmission();
    });

    // Initial status
    node.status({ fill: "grey", shape: "ring", text: "Stopped" });
  }

  RED.nodes.registerType("rp-folder-in", FolderInNode);
};
