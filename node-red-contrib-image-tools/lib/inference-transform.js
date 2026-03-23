/**
 * Inference coordinate transform library.
 * Transforms detection/segmentation coordinates when images are geometrically modified.
 * Pure JavaScript — no dependency on Node-RED runtime.
 */
'use strict';

// ─── Helpers ────────────────────────────────────────────────────────────────

function clipNorm(v) { return Math.max(0, Math.min(1, v)); }

function deepClone(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Buffer.isBuffer(obj)) return Buffer.from(obj);
  if (Array.isArray(obj)) return obj.map(deepClone);
  const out = {};
  for (const k of Object.keys(obj)) out[k] = deepClone(obj[k]);
  return out;
}

function transformPoints(points, fn) {
  return points.map(p => fn(p[0], p[1]));
}

function clipPoints(points) {
  return points.map(p => [clipNorm(p[0]), clipNorm(p[1])]);
}

/** Shoelace formula — returns absolute area of a polygon in normalized coords. */
function shoelaceArea(polygon) {
  let a = 0;
  const n = polygon.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += polygon[i][0] * polygon[j][1];
    a -= polygon[j][0] * polygon[i][1];
  }
  return Math.abs(a) / 2;
}

/**
 * Re-sort 4 corner points into canonical clockwise order: TL, TR, BR, BL.
 * After geometric transforms (rotation, etc.) the point order may change.
 */
function reorderBoxPoints(points) {
  if (!points || points.length !== 4) return points;

  // Sort by y ascending (top points first), break ties by x
  const sorted = [...points].sort((a, b) => a[1] - b[1] || a[0] - b[0]);

  // Top two points: smaller x = TL, larger x = TR
  const top = sorted.slice(0, 2).sort((a, b) => a[0] - b[0]);
  // Bottom two points: larger x = BR, smaller x = BL
  const bot = sorted.slice(2, 4).sort((a, b) => b[0] - a[0]);

  return [top[0], top[1], bot[0], bot[1]]; // TL, TR, BR, BL
}

// ─── Box Format Recalculation ───────────────────────────────────────────────

/**
 * Given a detection with transformed `raw_boxes`, recalculate all derived
 * box formats that were present on the original detection.
 */
function recalculateBoxFormats(det) {
  // Re-sort points into canonical TL, TR, BR, BL order
  det.raw_boxes = reorderBoxPoints(det.raw_boxes);
  const rb = det.raw_boxes; // [[x0,y0],[x1,y1],[x2,y2],[x3,y3]]

  // 2points — axis-aligned bounding box
  if (det.hasOwnProperty('2points')) {
    const xs = rb.map(p => p[0]), ys = rb.map(p => p[1]);
    det['2points'] = {
      xmin: Math.min(...xs), ymin: Math.min(...ys),
      xmax: Math.max(...xs), ymax: Math.max(...ys)
    };
  }

  // 4points — flat
  if (det.hasOwnProperty('4points')) {
    det['4points'] = {
      x0: rb[0][0], y0: rb[0][1],
      x1: rb[1][0], y1: rb[1][1],
      x2: rb[2][0], y2: rb[2][1],
      x3: rb[3][0], y3: rb[3][1]
    };
  }

  // Oriented box metrics (shared by xywhr and cwh)
  const dx = rb[1][0] - rb[0][0];
  const dy = rb[1][1] - rb[0][1];
  const w = Math.sqrt(dx * dx + dy * dy);
  const dx2 = rb[3][0] - rb[0][0];
  const dy2 = rb[3][1] - rb[0][1];
  const h = Math.sqrt(dx2 * dx2 + dy2 * dy2);
  const r = Math.atan2(dy, dx) * (180 / Math.PI);

  // xywhr — top-left, width, height, rotation
  if (det.hasOwnProperty('xywhr')) {
    det.xywhr = { x: rb[0][0], y: rb[0][1], w, h, r };
  }

  // cwh — center, width, height, rotation
  if (det.hasOwnProperty('cwh')) {
    const cx = (rb[0][0] + rb[2][0]) / 2;
    const cy = (rb[0][1] + rb[2][1]) / 2;
    det.cwh = { x: cx, y: cy, w, h, r };
  }
}

// ─── Overlap computation ────────────────────────────────────────────────────

/**
 * Compute the fraction of a detection's axis-aligned bounding box that
 * overlaps with the crop window (all in normalized coords).
 */
function overlapFraction(rawBoxes, cropRegion) {
  const { x0, y0, w, h } = cropRegion;
  const xs = rawBoxes.map(p => p[0]), ys = rawBoxes.map(p => p[1]);
  const bxMin = Math.min(...xs), bxMax = Math.max(...xs);
  const byMin = Math.min(...ys), byMax = Math.max(...ys);

  const bArea = (bxMax - bxMin) * (byMax - byMin);
  if (bArea <= 0) return 0;

  const ixMin = Math.max(bxMin, x0);
  const iyMin = Math.max(byMin, y0);
  const ixMax = Math.min(bxMax, x0 + w);
  const iyMax = Math.min(byMax, y0 + h);

  const iw = Math.max(0, ixMax - ixMin);
  const ih = Math.max(0, iyMax - iyMin);
  return (iw * ih) / bArea;
}

// ─── Detection Transform ────────────────────────────────────────────────────

/**
 * @param {object} det  — detection with raw_boxes
 * @param {function} pointFn — (x,y) => [nx,ny]
 * @param {object} opts — { clip, cropRegion, minOverlap }
 * @returns {object|null} transformed detection or null if filtered out
 */
function transformDetection(det, pointFn, opts = {}) {
  // Check overlap before cloning (optimization)
  if (opts.cropRegion) {
    const frac = overlapFraction(det.raw_boxes, opts.cropRegion);
    if (frac < (opts.minOverlap || 0.1)) return null;
  }

  const d = deepClone(det);
  d.raw_boxes = transformPoints(d.raw_boxes, pointFn);
  if (opts.clip) d.raw_boxes = clipPoints(d.raw_boxes);
  recalculateBoxFormats(d);
  return d;
}

// ─── Segmentation Transform ─────────────────────────────────────────────────

/**
 * @param {object} seg — segmentation with polygons and optional mask
 * @param {function} pointFn
 * @param {object} opts — { clip, maskTransformFn }
 * @returns {Promise<object|null>}
 */
async function transformSegmentation(seg, pointFn, opts = {}) {
  const s = deepClone(seg);

  // Transform polygons
  if (s.polygons && Array.isArray(s.polygons)) {
    s.polygons = s.polygons.map(contour => {
      let pts = transformPoints(contour, pointFn);
      if (opts.clip) pts = clipPoints(pts);
      return pts;
    }).filter(c => c.length >= 3);

    // Recalculate area
    s.area = s.polygons.reduce((sum, c) => sum + shoelaceArea(c), 0);
  }

  // Segmentations from the inferencer may also carry raw_boxes — transform them too
  if (s.raw_boxes && Array.isArray(s.raw_boxes) && s.raw_boxes.length === 4) {
    s.raw_boxes = transformPoints(s.raw_boxes, pointFn);
    if (opts.clip) s.raw_boxes = clipPoints(s.raw_boxes);
    s.raw_boxes = reorderBoxPoints(s.raw_boxes);
    recalculateBoxFormats(s);
  }

  // Transform bitmap mask
  if (s.mask && opts.maskTransformFn) {
    try {
      s.mask = await opts.maskTransformFn(s.mask);
    } catch (e) {
      // Non-fatal: drop the mask if transform fails
      delete s.mask;
    }
  }

  // Filter out if nothing useful remains
  if ((!s.polygons || s.polygons.length === 0) && !s.mask) return null;

  return s;
}

// ─── Per-Transform Point Function Makers ────────────────────────────────────

function makeResizeTransform(params) {
  // Normalized coords are invariant under resize — identity for points.
  // Bitmap masks DO need resizing though.
  const { origW, origH, newW, newH } = params;
  return {
    pointFn: (x, y) => [x, y],
    opts: {},
    maskTransformFn: (newW && newH && (newW !== origW || newH !== origH))
      ? async (mask, cppBridge) => {
          const { image } = await cppBridge.resize(mask, 'set', newW, 'set', newH, 'raw', 90, false);
          return image;
        }
      : null,
    _maskParams: { type: 'resize', newW, newH }
  };
}

function makeRotateTransform(params) {
  const { angleDeg, origW, origH } = params;
  const DEG = Math.PI / 180;
  const eps = 1e-3;
  const norm = ((angleDeg % 360) + 360) % 360;

  // Fast paths for exact 90/180/270
  const near = (a) => Math.abs(norm - a) < eps;

  if (near(0)) {
    return { pointFn: (x, y) => [x, y], opts: {}, maskTransformFn: null };
  }
  if (near(90)) {
    // Empirically verified: angle=90 produces CW rotation (BLUE→TL, RED→TR)
    return {
      pointFn: (x, y) => [1 - y, x],
      opts: {},
      maskTransformFn: async (mask, cppBridge) => {
        const { image } = await cppBridge.rotate(mask, 90, '#00000000', 'raw', 90, false);
        return image;
      }
    };
  }
  if (near(180)) {
    return {
      pointFn: (x, y) => [1 - x, 1 - y],
      opts: {},
      maskTransformFn: async (mask, cppBridge) => {
        const { image } = await cppBridge.rotate(mask, 180, '#00000000', 'raw', 90, false);
        return image;
      }
    };
  }
  if (near(270)) {
    // Empirically verified: angle=270 produces CCW rotation
    return {
      pointFn: (x, y) => [y, 1 - x],
      opts: {},
      maskTransformFn: async (mask, cppBridge) => {
        const { image } = await cppBridge.rotate(mask, 270, '#00000000', 'raw', 90, false);
        return image;
      }
    };
  }

  // Arbitrary angle — replicate OpenCV getRotationMatrix2D + adjust
  const rad = angleDeg * DEG;
  const cosA = Math.cos(rad), sinA = Math.sin(rad);
  const absCos = Math.abs(cosA), absSin = Math.abs(sinA);
  const W = origW, H = origH;
  const newW = Math.round(H * absSin + W * absCos);
  const newH = Math.round(H * absCos + W * absSin);
  const cx = W / 2, cy = H / 2;

  // Affine matrix coefficients (matching rotate.cpp:73-80)
  const alpha = cosA, beta = sinA;
  const m02 = (1 - alpha) * cx - beta * cy + (newW / 2 - cx);
  const m12 = beta * cx + (1 - alpha) * cy + (newH / 2 - cy);

  return {
    pointFn: (nx, ny) => {
      const px = nx * W;
      const py = ny * H;
      const px2 = alpha * px + beta * py + m02;
      const py2 = -beta * px + alpha * py + m12;
      return [px2 / newW, py2 / newH];
    },
    opts: {},
    maskTransformFn: async (mask, cppBridge) => {
      const { image } = await cppBridge.rotate(mask, angleDeg, '#00000000', 'raw', 90, false);
      return image;
    }
  };
}

function makeCropTransform(params) {
  const { x0, y0, w, h } = params; // all normalized 0-1
  return {
    pointFn: (nx, ny) => [(nx - x0) / w, (ny - y0) / h],
    opts: { clip: true, cropRegion: { x0, y0, w, h }, minOverlap: 0.1 },
    maskTransformFn: async (mask, cppBridge) => {
      const { image } = await cppBridge.crop(mask, x0, y0, w, h, true, 'raw', 90, false);
      return image;
    }
  };
}

function makePaddingTransform(params) {
  const { top, bottom, left, right, origW, origH } = params;
  const newW = origW + left + right;
  const newH = origH + top + bottom;
  return {
    pointFn: (nx, ny) => [
      (nx * origW + left) / newW,
      (ny * origH + top) / newH
    ],
    opts: {},
    maskTransformFn: async (mask, cppBridge) => {
      const { image } = await cppBridge.padding(mask, top, bottom, left, right, '#00000000', 'raw', 90, false);
      return image;
    }
  };
}

// ─── Multi-Image Transform Makers ───────────────────────────────────────────

/**
 * Concat: returns an array of transform infos, one per input image.
 * Must replicate the sizing logic from concat.cpp.
 */
function makeConcatTransforms(params) {
  const { direction, strategy, imageDims } = params;
  const isHorizontal = direction === 'right' || direction === 'left';

  // Max cross-axis dimension
  const maxCross = isHorizontal
    ? Math.max(...imageDims.map(d => d.height))
    : Math.max(...imageDims.map(d => d.width));

  // Compute placed dimensions and offsets for each image
  const placements = [];
  for (const dim of imageDims) {
    let placedW, placedH, padBefore = 0;

    if (strategy === 'resize') {
      if (isHorizontal) {
        const scale = maxCross / dim.height;
        placedW = Math.round(dim.width * scale);
        placedH = maxCross;
      } else {
        const scale = maxCross / dim.width;
        placedW = maxCross;
        placedH = Math.round(dim.height * scale);
      }
    } else {
      placedW = dim.width;
      placedH = dim.height;
      const delta = isHorizontal ? (maxCross - dim.height) : (maxCross - dim.width);
      if (delta > 0) {
        if (strategy === 'pad-start') padBefore = delta;
        else if (strategy === 'pad-end') padBefore = 0;
        else padBefore = Math.floor(delta / 2); // pad-both
      }
    }
    placements.push({ placedW, placedH, padBefore, origW: dim.width, origH: dim.height });
  }

  // Compute offsets along main axis
  let offset = 0;
  // For direction=up, C++ reverses tile order before vconcat
  const order = (direction === 'up') ? [...placements].reverse() : placements;

  // Build offset array indexed by original image index
  const offsetByIdx = new Array(placements.length);
  for (let oi = 0; oi < order.length; oi++) {
    const origIdx = (direction === 'up') ? (placements.length - 1 - oi) : oi;
    if (isHorizontal) {
      offsetByIdx[origIdx] = { x: offset, y: 0 };
      offset += order[oi].placedW;
    } else {
      offsetByIdx[origIdx] = { x: 0, y: offset };
      offset += order[oi].placedH;
    }
  }

  // Total result dimensions
  let totalW, totalH;
  if (isHorizontal) {
    totalW = placements.reduce((s, p) => s + p.placedW, 0);
    totalH = maxCross;
  } else {
    totalW = maxCross;
    totalH = placements.reduce((s, p) => s + p.placedH, 0);
  }

  // Build transforms per image
  const transforms = placements.map((pl, i) => {
    const off = offsetByIdx[i];
    const rW = totalW, rH = totalH;

    let pointFn;
    if (strategy === 'resize') {
      pointFn = (nx, ny) => {
        const px = nx * pl.placedW + off.x;
        const py = ny * pl.placedH + off.y;
        return [px / rW, py / rH];
      };
    } else {
      // Padding strategy: coords map to original-sized area within padded tile
      const padOffX = isHorizontal ? 0 : pl.padBefore;
      const padOffY = isHorizontal ? pl.padBefore : 0;
      pointFn = (nx, ny) => {
        const px = nx * pl.origW + off.x + padOffX;
        const py = ny * pl.origH + off.y + padOffY;
        return [px / rW, py / rH];
      };
    }

    return { pointFn, opts: {} };
  });

  // For direction=left, C++ flips the entire result horizontally
  if (direction === 'left') {
    for (const t of transforms) {
      const origFn = t.pointFn;
      t.pointFn = (nx, ny) => {
        const [x2, y2] = origFn(nx, ny);
        return [1 - x2, y2];
      };
    }
  }

  return transforms;
}

/**
 * Mosaic: returns Map<arrayIndex, transformInfo[]>.
 * Each image can appear at multiple positions on the canvas.
 */
function makeMosaicTransform(params) {
  const { positions, canvasW, canvasH, imageDims, normalized } = params;
  const byImage = new Map();

  for (const pos of positions) {
    const idx = parseInt(pos.arrayIndex);
    if (idx < 0 || idx >= imageDims.length) continue;
    const imgW = imageDims[idx].width;
    const imgH = imageDims[idx].height;

    const posXpx = normalized ? pos.x * canvasW : pos.x;
    const posYpx = normalized ? pos.y * canvasH : pos.y;

    const tx = {
      pointFn: (nx, ny) => [
        (nx * imgW + posXpx) / canvasW,
        (ny * imgH + posYpx) / canvasH
      ],
      opts: { clip: true }
    };

    if (!byImage.has(idx)) byImage.set(idx, []);
    byImage.get(idx).push(tx);
  }

  return byImage;
}

/**
 * Advanced mosaic: like mosaic but with per-image resize and rotation.
 */
function makeAdvancedMosaicTransform(params) {
  const { imageConfigs, canvasW, canvasH, imageDims, normalized } = params;
  const byImage = new Map();

  for (const cfg of imageConfigs) {
    const idx = parseInt(cfg.arrayIndex);
    if (idx < 0 || idx >= imageDims.length) continue;

    const origW = imageDims[idx].width;
    const origH = imageDims[idx].height;

    // Placed dimensions (after optional resize)
    const placedW = (cfg.width && cfg.width > 0) ? cfg.width : origW;
    const placedH = (cfg.height && cfg.height > 0) ? cfg.height : origH;

    const posXpx = normalized ? cfg.x * canvasW : cfg.x;
    const posYpx = normalized ? cfg.y * canvasH : cfg.y;
    const rotation = cfg.rotation || 0;

    let pointFn;
    if (Math.abs(rotation) < 1e-3) {
      // No rotation — just scale + place
      pointFn = (nx, ny) => [
        (nx * placedW + posXpx) / canvasW,
        (ny * placedH + posYpx) / canvasH
      ];
    } else {
      // Rotation around placed image center, then place on canvas
      const rad = rotation * Math.PI / 180;
      const cosA = Math.cos(rad), sinA = Math.sin(rad);
      const pcx = placedW / 2, pcy = placedH / 2;

      pointFn = (nx, ny) => {
        // Scale to placed pixel coords
        const px = nx * placedW - pcx;
        const py = ny * placedH - pcy;
        // Rotate
        const rx = px * cosA - py * sinA + pcx;
        const ry = px * sinA + py * cosA + pcy;
        // Place on canvas
        return [(rx + posXpx) / canvasW, (ry + posYpx) / canvasH];
      };
    }

    const tx = { pointFn, opts: { clip: true } };
    if (!byImage.has(idx)) byImage.set(idx, []);
    byImage.get(idx).push(tx);
  }

  return byImage;
}

// ─── High-Level Orchestrators ───────────────────────────────────────────────

/**
 * Apply a single transform to an array of inferences (detections + segmentations mixed).
 * @param {Array} inferences
 * @param {object} txInfo — { pointFn, opts, maskTransformFn }
 * @param {object} cppBridge — for bitmap mask transforms
 * @returns {Promise<Array>}
 */
async function applyTransform(inferences, txInfo, cppBridge) {
  if (!inferences || !Array.isArray(inferences) || inferences.length === 0) {
    return inferences || [];
  }

  const { pointFn, opts = {}, maskTransformFn } = txInfo;
  const results = [];

  for (const item of inferences) {
    if (item.polygons) {
      // Segmentation
      const mfn = maskTransformFn
        ? (mask) => maskTransformFn(mask, cppBridge)
        : null;
      const t = await transformSegmentation(item, pointFn, { ...opts, maskTransformFn: mfn });
      if (t) results.push(t);
    } else if (item.raw_boxes) {
      // Detection
      const t = transformDetection(item, pointFn, opts);
      if (t) results.push(t);
    } else {
      // Unknown format — pass through unchanged
      results.push(deepClone(item));
    }
  }

  return results;
}

/**
 * Apply transforms for multi-image operations (concat, mosaic).
 * @param {Array} infArrays — parallel array [infs_for_img0, infs_for_img1, ...]
 * @param {Array|Map} transforms — array (concat) or Map<idx, tx[]> (mosaic)
 * @param {object} cppBridge
 * @returns {Promise<Array>} merged flat array
 */
async function applyMultiImageTransform(infArrays, transforms, cppBridge) {
  if (!infArrays || !Array.isArray(infArrays)) return [];

  const merged = [];

  if (Array.isArray(transforms)) {
    // Concat mode: transforms[i] for infArrays[i]
    for (let i = 0; i < transforms.length; i++) {
      const infs = infArrays[i];
      if (!infs || !Array.isArray(infs) || infs.length === 0) continue;
      const results = await applyTransform(infs, transforms[i], cppBridge);
      merged.push(...results);
    }
  } else if (transforms instanceof Map) {
    // Mosaic mode: transforms.get(idx) => array of txInfos
    for (const [idx, txList] of transforms) {
      const infs = infArrays[idx];
      if (!infs || !Array.isArray(infs) || infs.length === 0) continue;
      for (const tx of txList) {
        const results = await applyTransform(infs, tx, cppBridge);
        merged.push(...results);
      }
    }
  }

  return merged;
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  // Helpers
  clipNorm,
  transformPoints,
  shoelaceArea,
  reorderBoxPoints,
  recalculateBoxFormats,
  overlapFraction,

  // Core transforms
  transformDetection,
  transformSegmentation,

  // Per-operation transform makers
  makeResizeTransform,
  makeRotateTransform,
  makeCropTransform,
  makePaddingTransform,
  makeConcatTransforms,
  makeMosaicTransform,
  makeAdvancedMosaicTransform,

  // Orchestrators
  applyTransform,
  applyMultiImageTransform
};
