/**
 * @file Pure-JS BMP decoder for uncompressed BI_RGB files (8/24/32-bit).
 * Read-side counterpart of encodeBmpRaw in image-out; Sharp cannot read BMP.
 * @author Rosepetal
 */

function isBmp(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4D;
}

// Decodes a BMP buffer to the toolkit's raw image object.
// Supports 8-bit palette, 24-bit and 32-bit uncompressed, top-down and bottom-up.
function decodeBmp(buf) {
  if (!isBmp(buf) || buf.length < 54) throw new Error('Invalid BMP file');

  const pixelOffset = buf.readUInt32LE(10);
  const infoSize = buf.readUInt32LE(14);
  if (infoSize < 40) throw new Error(`Unsupported BMP header (size ${infoSize})`);

  const width = buf.readInt32LE(18);
  const rawHeight = buf.readInt32LE(22);
  const bpp = buf.readUInt16LE(28);
  const compression = buf.readUInt32LE(30);

  const topDown = rawHeight < 0;
  const height = Math.abs(rawHeight);
  if (width <= 0 || height === 0) throw new Error('Invalid BMP dimensions');
  if (compression !== 0) throw new Error(`Unsupported BMP compression ${compression} (only uncompressed BI_RGB)`);
  if (bpp !== 8 && bpp !== 24 && bpp !== 32) throw new Error(`Unsupported BMP bit depth ${bpp} (only 8/24/32)`);

  const srcStride = (width * (bpp / 8) + 3) & ~3;
  if (pixelOffset + srcStride * height > buf.length) throw new Error('Corrupt BMP: pixel data truncated');

  // 8-bit files carry a BGRA palette; an all-gray palette maps to a GRAY image
  let palette = null;
  let grayPalette = false;
  if (bpp === 8) {
    const colors = buf.readUInt32LE(46) || 256;
    const palOffset = 14 + infoSize;
    if (palOffset + colors * 4 > buf.length) throw new Error('Corrupt BMP: palette truncated');
    palette = [];
    grayPalette = true;
    for (let i = 0; i < colors; i++) {
      const b = buf[palOffset + i * 4], g = buf[palOffset + i * 4 + 1], r = buf[palOffset + i * 4 + 2];
      if (r !== g || g !== b) grayPalette = false;
      palette.push([r, g, b]);
    }
  }

  const channels = bpp === 32 ? 4 : (bpp === 24 || !grayPalette) ? 3 : 1;
  const colorSpace = channels === 4 ? 'RGBA' : channels === 3 ? 'RGB' : 'GRAY';
  const out = Buffer.alloc(width * height * channels);

  for (let y = 0; y < height; y++) {
    const srcRow = pixelOffset + (topDown ? y : height - 1 - y) * srcStride;
    const dstRow = y * width * channels;
    if (bpp === 8) {
      for (let x = 0; x < width; x++) {
        const entry = palette[buf[srcRow + x]] || [0, 0, 0];
        if (channels === 1) {
          out[dstRow + x] = entry[0];
        } else {
          const d = dstRow + x * 3;
          out[d] = entry[0]; out[d + 1] = entry[1]; out[d + 2] = entry[2];
        }
      }
    } else {
      for (let x = 0; x < width; x++) {
        const s = srcRow + x * (bpp / 8), d = dstRow + x * channels;
        out[d] = buf[s + 2]; out[d + 1] = buf[s + 1]; out[d + 2] = buf[s]; // BGR → RGB
        if (channels === 4) out[d + 3] = buf[s + 3];
      }
    }
  }

  return { data: out, width, height, channels, colorSpace, dtype: 'uint8' };
}

module.exports = { isBmp, decodeBmp };
