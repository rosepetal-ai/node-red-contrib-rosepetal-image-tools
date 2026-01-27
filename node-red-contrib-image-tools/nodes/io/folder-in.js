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

module.exports = function(RED) {
  const NodeUtils = require('../../lib/node-utils.js')(RED);

  function FolderInNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    // Node state
    let running = false;
    let intervalTimer = null;
    let imageFiles = [];
    let currentIndex = 0;
    let folderPath = null;

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

        // Use Sharp to decode image with full metadata
        const sharpInstance = sharp(fileBuffer);
        const decodeStart = performance.now();
        const { data, info } = await sharpInstance
          .clone()
          .raw()
          .toBuffer({ resolveWithObject: true });
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

            // Prefer sending the original encoded buffer when format is supported
            let debugSource = outputImageObject;
            let debugFormatHint = 'raw';

            if (info && info.format) {
              const normalizedFormat = info.format.toLowerCase();
              if (normalizedFormat === 'jpeg' || normalizedFormat === 'jpg') {
                debugSource = fileBuffer;
                debugFormatHint = 'jpg';
              } else if (normalizedFormat === 'png') {
                debugSource = fileBuffer;
                debugFormatHint = 'png';
              } else if (normalizedFormat === 'webp') {
                debugSource = fileBuffer;
                debugFormatHint = 'webp';
              }
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

    /**
     * Starts the interval-based emission
     */
    async function startEmission() {
      if (running) return;

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
      let intervalMs = config.interval || 1000;
      if (config.intervalType === 'msg' || config.intervalType === 'flow' || config.intervalType === 'global') {
        // For dynamic intervals, use default for now - can be enhanced with message input
        intervalMs = config.interval || 1000;
      }
      intervalMs = parseInt(intervalMs);

      node.status({ fill: "green", shape: "dot", text: `Started (${imageFiles.length} images, ${intervalMs}ms)` });

      // Emit first image immediately
      await emitNextImage();

      // Start interval timer for subsequent images
      if (running) { // Check if still running after first emit
        intervalTimer = setInterval(emitNextImage, intervalMs);
      }
    }

    /**
     * Stops the interval-based emission
     */
    function stopEmission() {
      if (!running) return;

      running = false;
      if (intervalTimer) {
        clearInterval(intervalTimer);
        intervalTimer = null;
      }

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

  RED.nodes.registerType("folder-in", FolderInNode);
};
