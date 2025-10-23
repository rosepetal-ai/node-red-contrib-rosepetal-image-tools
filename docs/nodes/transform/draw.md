# Draw Node

## Purpose & Use Cases

The `draw` node overlays configurable points and lines on top of an input image using normalized coordinates. Rendering happens in the Rosepetal C++ engine, keeping overlays crisp even on high-resolution imagery.

**Typical scenarios**
- Visualizing detections (keypoints, landmarks, segmentation anchors)
- Highlighting measurement locations or points-of-interest
- Connecting bounding boxes with relational lines
- Creating quick debugging overlays inside automation flows

## Input / Output

### Input
- **Image**: Single image object or encoded buffer following the standard toolkit format (`data`, `width`, `height`, `channels`, `colorSpace`, `dtype`).
- Source path defaults to `msg.payload` and can be remapped to any `msg`, `flow`, or `global` property.

### Output
- Augmented image delivered in raw format (default) or encoded as `jpg`, `png`, or `webp`, matching the rest of the toolkit conventions.
- Output path defaults to `msg.payload`.

## Configuration

### I/O
- **Input From / Output To**: Typed inputs (`msg`, `flow`, `global`) for flexible integration.
- **Output Format**: `raw`, `jpg`, `png`, or `webp`. Quality and PNG optimization options appear when relevant.

### Points
Each list entry configures one point:
- **X / Y**: Normalized coordinates (`0.0 – 1.0`) with dynamic sources (`num`, `msg`, `flow`, `global`).
- **Radius**: Normalized size relative to the shortest image dimension (minimum 1 pixel).
- **Color**: Hex string (e.g. `#FF0066`). Can be resolved from context if needed.
- **Opacity**: Overlay strength (`0.0 – 1.0`). Combined with any alpha channel supplied in the color.

Click **+** to add points and **🗑** to remove. Fields keep their typed-input settings, allowing mixed static and dynamic values.

### Lines
Each list entry defines a polyline segment:
- **Start / End (X1, Y1, X2, Y2)**: Normalized coordinates.
- **Thickness**: Normalized width relative to the shortest dimension (minimum 1 pixel).
- **Color**: Hex string or dynamic string.
- **Opacity**: Blend factor (`0.0 – 1.0`).

### Debugging
- **Debug switch**: Streams a preview via the standard Rosepetal debug channel.
- **Debug width**: Typed value controlling the preview size.

## Runtime Behaviour

1. The node validates the input image using shared `node-utils` helpers.
2. Points and lines are resolved via typed inputs—dynamic properties are evaluated per message.
3. The C++ engine converts normalized coordinates to pixels and composites overlays with anti-aliasing and alpha-aware blending.
4. Timing information (convert / task / encode) feeds the standard status display.
5. Optional debug previews reuse the existing toolkit infrastructure (`debug-image` WebSocket).

## Tips & Edge Cases

- Coordinates outside `[0, 1]` are rejected with warns and skipped.
- Empty point and line lists pass the image through unchanged.
- Opacity multiplies the color alpha, so `#FF000080` at opacity `0.5` results in 25% final strength.
- Grayscale inputs are supported; color overlays are converted using luminance weighting.
- For chained overlays, prefer `raw` output to avoid repeated re-encoding.

## Example Flow

```
[image-in]
   └─▶ [draw]
          • point: x=msg.face.x, y=msg.face.y, radius=0.02, color=#00FFEE
          • line:  x1=0.1, y1=0.9 → x2=0.9, y2=0.9, thickness=0.004, color=#FFAA00
   └─▶ [image-out]
```

This creates a face marker plus a baseline overlay, fully driven by message content.
