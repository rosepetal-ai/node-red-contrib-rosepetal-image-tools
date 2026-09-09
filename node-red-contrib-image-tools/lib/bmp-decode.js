/**
 * @file BMP support for the image-in / folder-in nodes.
 * Sharp cannot read BMP, so BMP files are decoded by the native engine
 * (OpenCV, on the libuv thread pool) instead of a pure-JS pixel loop that
 * would block the Node-RED event loop.
 * @author Rosepetal
 */

const Cpp = require('./cpp-bridge.js');

function isBmp(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4D;
}

/**
 * Decodes a BMP buffer to the toolkit's raw image object.
 * Supports every uncompressed / RLE BMP variant OpenCV handles (1/4/8-bit
 * palette, 16/24/32-bit). Grayscale palettes yield a GRAY image, colour
 * palettes and 24-bit files yield RGB, 32-bit files yield RGBA.
 * @param {Buffer} buf
 * @returns {Promise<{data: Buffer, width: number, height: number, channels: number, colorSpace: string, dtype: string}>}
 */
async function decodeBmp(buf) {
  if (!isBmp(buf)) throw new Error('Invalid BMP file');
  const { image } = await Cpp.decode(buf);
  return image;
}

module.exports = { isBmp, decodeBmp };
