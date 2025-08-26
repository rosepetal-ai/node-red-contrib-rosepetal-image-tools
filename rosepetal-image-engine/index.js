/**
 * @file Entry point for the rosepetal-image-engine C++ addon
 * Exports the compiled native addon for use in Node.js applications
 * @author Rosepetal
 */

try {
  // Export the compiled C++ addon
  module.exports = require('./build/Release/addon.node');
} catch (error) {
  // Provide helpful error message if the addon isn't built
  throw new Error(
    'Rosepetal Image Engine addon not found. Please run "npm run rebuild" to compile the C++ addon.\n' +
    'Original error: ' + error.message
  );
}