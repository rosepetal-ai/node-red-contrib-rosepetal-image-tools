/**
 * @file This bridge loads the native C++ addon and promisifies its functions.
 */
const util = require('util');
const addon = require('rosepetal-image-engine/build/Release/addon.node');

const promisifiedAddon = {};

// Promisify all functions exported from the C++ addon
for (const key in addon) {
  if (typeof addon[key] === 'function') {
    promisifiedAddon[key] = util.promisify(addon[key]);
  }
}

module.exports = promisifiedAddon;