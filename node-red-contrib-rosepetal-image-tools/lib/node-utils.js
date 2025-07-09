/**
 * @file Contains generic helper functions for the Node-RED nodes.
 * This module is pure JavaScript and has no dependency on the RED object.
 * @author Rosepetal
 */

const sharp = require('sharp'); // Ensure sharp is installed in your project


module.exports = function(RED) {
  const utils = {};

  utils.validateSingleImage = function(image, node) {
    if (!image || !Buffer.isBuffer(image.data) || !image.width || !image.height || !image.channels) {
        node.error("Input could not be normalized to a valid image object.", { payload: image });
        return false;
    }
    return true;
  }

  utils.validateListImage = function(list, node) {
    if (!list || !Array.isArray(list) || list.length === 0) {
      node.error("Input is not a valid image list. Expected a non-empty Array.", { payload: list });
      return false;
    }
    // Validate each item in the list
    for (const image of list) {
      if (!utils.validateSingleImage(image, node)) {
        // The error message is already sent by validateSingleImage
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

  utils.rawToJpeg = async function (image, quality = 90) {
    if (!utils.validateSingleImage(image, { error: () => {} }))
      throw new Error('Invalid raw image object supplied to rawToJpeg');

    const [, chanStr] = image.channels.split('_'); // "RGB", "BGRA", …
    const channels =
      chanStr === 'GRAY' ? 1 : chanStr.endsWith('A') ? 4 : 3;

    let data = image.data;

    // BGR/BGRA → RGB/RGBA
    if (chanStr === 'BGR' || chanStr === 'BGRA') {
      data = Buffer.from(data); // copy so we don’t mutate shared memory
      for (let i = 0; i < data.length; i += channels) {
        const t = data[i];
        data[i] = data[i + 2];
        data[i + 2] = t;
      }
    }

    const sh = sharp(data, {
      raw: { width: image.width, height: image.height, channels }
    });

    if (chanStr === 'GRAY') sh.toColourspace('b-w');

    return sh.jpeg({ quality }).toBuffer();
  }

  utils.handleNodeError = function(node, error, msg, done) {
    const errorMessage = error.message || "Unknown error during processing.";
    node.error(errorMessage, msg);
    node.status({ fill: "red", shape: "ring", text: "Error" });
    if (done) {
      done(error);
    }
  }

  return utils;
}
