/**
 * @file Contains generic helper functions for the Node-RED nodes.
 * This module is pure JavaScript and has no dependency on the RED object.
 * @author Rosepetal
 */

/**
 * Validates if the given payload is a valid single image object.
 * @param {*} image The data to validate, which should be an image object.
 * @param {object} node The node instance to call .error() on.
 * @returns {boolean} True if valid, false otherwise.
 */
function validateSingleImage(image, node) {
  if (!image || typeof image !== 'object' || Buffer.isBuffer(image) || Array.isArray(image)) {
    node.error("An item in the payload is not a valid image object. Expected { data: Buffer, ... }.", { payload: image });
    return false;
  }
  if (!Buffer.isBuffer(image.data) || image.data.length === 0 || !image.width || !image.height || !image.channels) {
    node.error("An item in the payload is an invalid image object. It must contain { data, width, height, channels }.", { payload: image });
    return false;
  }
  return true;
}

/**
 * Validates if the given payload is a valid array of image objects.
 * @param {*} list The data to validate, which should be an array of images.
 * @param {object} node The node instance to call .error() on.
 * @returns {boolean} True if valid, false otherwise.
 */
function validateListImage(list, node) {
  if (!list || !Array.isArray(list) || list.length === 0) {
    node.error("Input is not a valid image list. Expected a non-empty Array.", { payload: list });
    return false;
  }
  // Validate each item in the list
  for (const image of list) {
    if (!validateSingleImage(image, node)) {
      // The error message is already sent by validateSingleImage
      return false;
    }
  }
  return true;
}

/**
 * Centrally manages errors that occur during processing within a node.
 * @param {object} node The current node instance.
 * @param {Error} error The error object caught in a catch block.
 * @param {object} msg The original message that caused the error.
 * @param {function} done The Node-RED 'done' callback.
 */
function handleNodeError(node, error, msg, done) {
  const errorMessage = error.message || "Unknown error during processing.";
  node.error(errorMessage, msg);
  node.status({ fill: "red", shape: "ring", text: "Error" });
  if (done) {
    done(error);
  }
}

// Export the corrected functions
module.exports = {
  validateSingleImage,
  validateListImage,
  handleNodeError
};