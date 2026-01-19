"use strict";

const util = require("util");

module.exports = function registerCleanDebugNode(RED) {
  const DEFAULT_DEBUG_MAX_LENGTH = (RED.settings && RED.settings.debugMaxLength) || 1000;
  const BUFFER_PREVIEW_BYTES = Math.max(DEFAULT_DEBUG_MAX_LENGTH, 512);

  function CleanDebugNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.name = config.name;
    node.active = config.active !== false;
    node.tosidebar = config.tosidebar !== false;
    node.console = !!config.console;
    node.complete = (config.complete && config.complete !== "") ? config.complete : "payload";
    node.targetType = config.targetType || "msg";
    node.clean = config.clean !== false; // default true

    node.on("input", function onInput(msg, send, done) {
      if (!node.active) {
        if (done) {
          done();
        }
        return;
      }

      resolveDebugValue(msg)
        .then((resolved) => handleDebugOutput(msg, resolved))
        .then(() => {
          if (done) {
            done();
          }
        })
        .catch((err) => {
          node.error(err && err.message ? err.message : err, msg);
          if (done) {
            done(err);
          }
        });
    });

    /**
     * Resolve the configured value the node should display.
     * @param {object} msg
     * @returns {Promise<*>}
     */
    function resolveDebugValue(msg) {
      if (node.targetType === "full" || node.targetType === "complete") {
        return Promise.resolve(RED.util.cloneMessage(msg));
      }

      if (node.targetType === "msg" || node.targetType === "msgProperty") {
        const property = node.complete || "payload";
        try {
          return Promise.resolve(RED.util.getMessageProperty(msg, property));
        } catch (err) {
          return Promise.reject(err);
        }
      }

      return new Promise((resolve, reject) => {
        const property = node.complete || "";
        RED.util.evaluateNodeProperty(property, node.targetType, node, msg, (err, value) => {
          if (err) {
            reject(err);
          } else {
            resolve(value);
          }
        });
      });
    }

    /**
     * Emit to the configured outputs (sidebar/console).
     * @param {object} msg
     * @param {*} value
     */
    function handleDebugOutput(msg, value) {
      const mode = node.clean ? "clean" : "full";
      const preparedValue = sanitiseValue(value, { mode });

      if (node.console) {
        const consoleValue = node.clean ? preparedValue : value;
        const formatted = formatForConsole(consoleValue);
        node.log(formatted);
      }

      if (node.tosidebar !== false) {
        publishToSidebar(msg, preparedValue);
      }
    }

    /**
     * Publish the debug payload to the editor sidebar.
     * @param {object} msg
     * @param {*} value
     */
    function publishToSidebar(msg, value) {
      if (!RED.comms || typeof RED.comms.publish !== "function") {
        return;
      }

      const format = detectValueType(value);
      const debugMessage = {
        id: node.id,
        z: node.z,
        _alias: node._alias,
        name: node.name,
        topic: msg && msg.topic,
        property: node.targetType === "full" ? "msg" : node.complete,
        propertyType: node.targetType,
        clean: node.clean,
        format,
        msg: value,
        _msgid: msg && msg._msgid
      };

      RED.comms.publish("debug", debugMessage);
    }
  }

  /**
   * Produce a lightweight clone that is safe to ship to the editor.
   * @param {*} input
   * @param {object} [options]
   * @param {"clean"|"full"} [options.mode="clean"]
   * @returns {*}
   */
  function sanitiseValue(input, options = {}) {
    const mode = options.mode === "full" ? "full" : "clean";
    const opts = {
      maxDepth: options.maxDepth || 6,
      maxArrayLength: options.maxArrayLength || (mode === "clean" ? 50 : 100),
      maxObjectKeys: options.maxObjectKeys || (mode === "clean" ? 60 : 120),
      maxStringLength: options.maxStringLength || (mode === "clean" ? 2048 : DEFAULT_DEBUG_MAX_LENGTH),
      bufferPreviewLength: options.bufferPreviewLength || (mode === "clean" ? 0 : BUFFER_PREVIEW_BYTES),
      mode
    };

    const seen = new WeakMap();

    function helper(value, depth, path) {
      if (value === null || value === undefined) {
        return value;
      }

      const valueType = typeof value;
      if (valueType === "number" || valueType === "boolean") {
        return value;
      }
      if (valueType === "bigint") {
        return `${value.toString()}n`;
      }
      if (valueType === "string") {
        return sanitiseString(value, opts);
      }
      if (valueType === "symbol") {
        return value.toString();
      }
      if (valueType === "function") {
        return `[Function ${value.name || "anonymous"}]`;
      }

      if (Buffer.isBuffer(value)) {
        return encodeBuffer(value, opts);
      }
      if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
        return encodeTypedArray(value, opts);
      }
      if (value instanceof ArrayBuffer) {
        return encodeTypedArray(new Uint8Array(value), opts);
      }
      if (value instanceof Date) {
        return value.toISOString();
      }
      if (value instanceof RegExp) {
        return value.toString();
      }

      if (typeof value === "object") {
        if (seen.has(value)) {
          return `[Circular ~${seen.get(value)}]`;
        }
        seen.set(value, path || "~");

        if (value.type === "Buffer" && Array.isArray(value.data)) {
          if (opts.mode === "clean") {
            return createPlaceholder("Buffer", `${value.data.length} bytes`);
          }
          return encodeBuffer(Buffer.from(value.data), opts);
        }

        if (depth >= opts.maxDepth) {
          if (Array.isArray(value)) {
            return `[Array(${value.length})]`;
          }
          return `[Object with ${Object.keys(value).length} keys]`;
        }

        if (Array.isArray(value)) {
          const result = [];
          const len = Math.min(value.length, opts.maxArrayLength);
          for (let i = 0; i < len; i += 1) {
            const childPath = `${path || "~"}[${i}]`;
            result.push(helper(value[i], depth + 1, childPath));
          }
          if (value.length > opts.maxArrayLength) {
            result.push(`… ${value.length - opts.maxArrayLength} more items`);
          }
          return result;
        }

        const keys = Object.keys(value);
        const clone = {};
        const limit = Math.min(keys.length, opts.maxObjectKeys);

        for (let i = 0; i < limit; i += 1) {
          const key = keys[i];
          const childPath = path ? `${path}.${key}` : key;
          clone[key] = helper(value[key], depth + 1, childPath);
        }

        if (keys.length > opts.maxObjectKeys) {
          clone.__cleanDebugTruncated = true;
          clone.__cleanDebugNote = `${keys.length - opts.maxObjectKeys} more keys not shown`;
        }

        return clone;
      }

      return value;
    }

    return helper(input, 0, "");
  }

  /**
   * Sanitise long/base64 strings with heuristics.
   * @param {string} value
   * @param {object} opts
   */
  function sanitiseString(value, opts) {
    const trimmed = value.trim();
    if (opts.mode === "clean" && trimmed.startsWith("data:image/")) {
      return createPlaceholder("DataImage", `${value.length} chars`);
    }

    if (opts.mode === "clean" && isLikelyBase64(trimmed)) {
      return createPlaceholder("Base64", `${value.length} chars`);
    }

    if (value.length > opts.maxStringLength) {
      return `${value.slice(0, opts.maxStringLength)}… [truncated ${value.length - opts.maxStringLength} chars]`;
    }
    return value;
  }

  /**
   * Encode a buffer so the UI can inspect it without loading all bytes.
   * @param {Buffer} buffer
   * @param {object} opts
   */
  function encodeBuffer(buffer, opts) {
    if (opts.mode === "clean" || opts.bufferPreviewLength <= 0) {
      return createPlaceholder("Buffer", `${buffer.length} bytes`);
    }

    const previewLength = Math.min(buffer.length, opts.bufferPreviewLength);
    const slice = buffer.slice(0, previewLength).toJSON();
    slice.length = buffer.length;
    if (previewLength < buffer.length) {
      slice.__cleanDebugTruncated = true;
      slice.__cleanDebugNote = `${buffer.length - previewLength} more bytes not shown`;
    }
    return slice;
  }

  /**
   * Encode typed arrays safely.
   * @param {TypedArray} view
   * @param {object} opts
   */
  function encodeTypedArray(view, opts) {
    if (opts.mode === "clean") {
      const ctor = view.constructor && view.constructor.name ? view.constructor.name : "TypedArray";
      return createPlaceholder(ctor, `${view.length} items`);
    }

    const limit = Math.min(view.length, opts.maxArrayLength);
    const data = [];
    for (let i = 0; i < limit; i += 1) {
      data.push(view[i]);
    }
    const descriptor = {
      type: view.constructor && view.constructor.name ? view.constructor.name : "TypedArray",
      length: view.length,
      data
    };
    if (limit < view.length) {
      descriptor.__cleanDebugTruncated = true;
      descriptor.__cleanDebugNote = `${view.length - limit} more items not shown`;
    }
    return descriptor;
  }

  /**
   * Detect base64-ish strings that are long enough to be heavy payloads.
   * @param {string} value
   */
  function isLikelyBase64(value) {
    if (value.length < 512) {
      return false;
    }
    if (value.length % 4 !== 0) {
      return false;
    }
    if (!/^[A-Za-z0-9+/=\s]+$/.test(value)) {
      return false;
    }
    const paddingRatio = (value.match(/=/g) || []).length / value.length;
    return paddingRatio < 0.1;
  }

  /**
   * Generate placeholder string.
   */
  function createPlaceholder(type, detail) {
    return `[${type} withheld: ${detail}]`;
  }

  /**
   * Detect broad value type to help the editor render icons.
   * @param {*} value
   */
  function detectValueType(value) {
    if (value === null) {
      return "null";
    }
    if (value && typeof value === "object" && value.type === "Buffer" && Array.isArray(value.data)) {
      return "buffer";
    }
    const t = typeof value;
    if (t === "string" || t === "number" || t === "boolean" || t === "bigint") {
      return t;
    }
    if (Array.isArray(value)) {
      return "array";
    }
    if (value instanceof Date) {
      return "date";
    }
    return "object";
  }

  /**
   * Format for console/log output.
   * @param {*} value
   */
  function formatForConsole(value) {
    return util.inspect(value, {
      depth: 5,
      maxArrayLength: 10,
      breakLength: 120,
      maxStringLength: DEFAULT_DEBUG_MAX_LENGTH
    });
  }

  RED.nodes.registerType("clean-debug", CleanDebugNode);

  RED.httpAdmin.post("/clean-debug/:id", RED.auth.needsPermission("flows.write"), function(req, res) {
    const node = RED.nodes.getNode(req.params.id);
    if (!node) {
      res.sendStatus(404);
      return;
    }

    if (typeof node.active === "undefined") {
      node.active = true;
    }

    let desiredState;
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, "active")) {
      desiredState = !!req.body.active;
    } else {
      desiredState = !node.active;
    }
    node.active = desiredState;

    res.json({ active: node.active });
  });
};
