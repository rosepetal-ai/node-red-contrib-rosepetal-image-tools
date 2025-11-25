# add-masks

Applies multiple polygon-based masks to a base image using weighted blending with configurable mask strength and class-based color mapping.

## Description

The `add-masks` node extends the functionality of `add-mask` to handle multiple masks with automatic color assignment based on class names. It processes arrays of mask objects where each mask can have a different color based on its `class_name` property. Undefined classes can automatically receive randomly generated colors for visual distinction.

This node is ideal for visualizing object detection results, semantic segmentation, or any scenario where multiple regions need to be highlighted with different colors based on their classification.

## Input Structure

The node consumes an array of mask objects. It now accepts the exact segmentation output produced by the Rosepetal **inferencer** node (no manual conversion required):

- **Class name**: `tag`, `class_name`, `className`, `label`, or `class`
- **Geometry** (one of):
  - `polygons`: array of polygons; each polygon is an array of `[x, y]` points in **normalized** coordinates (0‑1)
  - `mask`: either a raw mask image `{data, width, height, channels, colorSpace, dtype}` (inferencer “mask” format) or a 2D matrix/array-of-matrices with numeric values (0/1 or 0‑255)
- Any extra fields are ignored. If both `polygons` and `mask` exist, polygons take priority.

**Example (direct inferencer output)**
```javascript
msg.payload = [
  {
    tag: "bottle",
    polygons: [[[0.1, 0.1], [0.9, 0.1], [0.9, 0.8], [0.1, 0.8]]]
  },
  {
    class_name: "person",
    mask: {
      width: 512,
      height: 512,
      channels: 4,
      colorSpace: "RGBA",
      dtype: "uint8",
      data: <Buffer ...>
    }
  }
];
```

## Configuration

### Paths
- **Image**: Message property path containing the base image (default: `payload.image`)
- **Masks Array**: Message property path containing the masks array (default: `payload`)
- **Output**: Message property path for the result (default: `payload`)

### Processing Options
- **Global Mask Strength**: 0-100% intensity of mask application (default: 50%)
- **Output Format**: Raw (fastest), JPEG, PNG, or WebP
- **Quality**: Compression quality for JPEG/WebP (1-100)

### Dynamic Class Color Mapping

The node provides a dynamic interface for managing class-to-color mappings:

#### Features:
- **Add/Remove Mappings**: Dynamic addition and removal of class color pairs
- **Real-time Validation**:
  - Duplicate class name detection
  - Similar color warnings (RGB distance < 50)
- **Visual Feedback**: Color swatches and warning indicators

#### Usage:
1. Click "Add Class Mapping" to create new entries
2. Enter class name (e.g., "dog", "cat", "zebra")
3. Select desired color using color picker
4. Remove unwanted mappings with trash button

## Color Assignment Priority

Colors are assigned using this priority order:

1. **User-defined mapping**: Colors explicitly set in the class color mappings
2. **Auto-generated**: Seeded random colors (always enabled)
3. **Default fallback**: White color (#ffffff)

## Processing Flow

1. **Structure Validation**: Validates the nested array structure
2. **Color Resolution**: Builds color map from configuration and auto-generation
3. **Mask Generation**: Creates binary masks for each polygon using OpenCV
4. **Multi-layer Blending**: Applies all masks with proper weight normalization
5. **Output Encoding**: Converts to specified format with quality settings

## Examples

### Basic Object Detection Visualization

**Input:**
```javascript
msg.payload = [
  {
    masks: [
      {
        mask: [[[0.1,0.1], [0.3,0.1], [0.3,0.3], [0.1,0.3]]],
        class_name: "dog"
      },
      {
        mask: [[[0.5,0.5], [0.7,0.5], [0.7,0.7], [0.5,0.7]]],
        class_name: "cat"
      }
    ]
  }
];
```

**Configuration:**
- dog → Red (#FF0000)
- cat → Blue (#0000FF)
- Global Mask Strength: 70%

**Result:** Image with red rectangle for dog and blue rectangle for cat

### Semantic Segmentation with Auto-Colors

**Input:** Multiple elements with various class names

**Configuration:**
- Only define colors for important classes
- System automatically generates colors for others

**Result:** Consistent coloring with user-defined colors for key classes and auto-generated colors for others

## Performance Characteristics

### Optimizations
- **C++ Backend**: OpenCV-powered processing with SIMD optimizations
- **Batch Processing**: All masks processed in single C++ call
- **Weight Normalization**: Prevents over-saturation when masks overlap
- **Memory Efficiency**: Reuses intermediate buffers across masks

### Timing Breakdown
Status displays show detailed timing:
- **Convert**: Time for input validation and format conversion
- **Task**: Time for mask generation and blending in C++
- **Encode**: Time for output format encoding (if not raw)

## Error Handling

### Input Validation
- **Structure validation**: Comprehensive checking of nested array format
- **Coordinate validation**: Ensures normalized range (0-1) for all coordinates
- **Class name validation**: Checks for non-empty string class names
- **Missing mask[0]**: Specific error for missing coordinate arrays

### Visual Feedback
- **Duplicate class warnings**: Real-time detection of duplicate class names
- **Color conflict warnings**: Alerts for visually similar colors
- **Processing status**: Shows number of masks processed and timing

## Advanced Features

### HSV-Based Color Generation
Auto-generated colors use HSV color space for better visual distinction:
- **Seeded randomization**: Consistent colors based on class name hash
- **Optimal distribution**: 70-100% saturation and value for vibrant colors
- **Visual separation**: Automatic spacing for distinguishable colors

### Multi-mask Blending Algorithm
```
For each mask:
  1. Generate binary mask from polygon coordinates
  2. Apply mask strength weighting
  3. Accumulate color contributions and total weights

Final blending:
  result = image × (1 - total_weights) + normalized_mask_colors
```

### Overlap Handling
When masks overlap, the blending algorithm:
- Accumulates color contributions from all overlapping masks
- Normalizes by total weight to prevent over-saturation
- Maintains visual clarity even with complex overlaps

## Integration Patterns

### With Object Detection Models
```javascript
// Convert model output to expected format
const masks = detectionResults.map(detection => ({
  masks: [{
    mask: [detection.polygon],
    class_name: detection.class
  }]
}));

msg.payload = masks;
```

### With Semantic Segmentation
```javascript
// Process segmentation masks
const masks = segmentationRegions.map(region => ({
  masks: [{
    mask: [region.contour],
    class_name: region.label
  }]
}));
```

### Chaining with Other Nodes
- **Upstream**: Works with `cropBB`, AI model outputs, or manual annotation tools
- **Downstream**: Connect to `image-out`, display components, or further processing
- **Flow integration**: Supports flow and global context for color persistence

## Troubleshooting

### Common Issues

**"Invalid element structure"**
- Check that each array element has `masks` property
- Ensure `masks` is an array, not an object

**"Missing mask[0]"**
- Verify that coordinates are in `mask[0]`, not directly in `mask`
- Check that `mask` array is not empty

**"Coordinates out of range"**
- Ensure all coordinates are normalized (0.0-1.0)
- Convert pixel coordinates to normalized before input

**"Duplicate class warnings"**
- Review class mappings for exact duplicates
- Consider using more specific class names

### Performance Tips
- Use raw format for processing chains (fastest)
- Define colors for frequently used classes to avoid repeated generation
- Monitor timing display to identify bottlenecks
- Process smaller images for real-time applications

## Node Interactions

### Compatible Nodes
- **Input sources**: `image-in`, `cropBB`, AI/ML model outputs
- **Output destinations**: `image-out`, `concat`, display nodes
- **Processing chains**: Can be chained with other blending nodes
- **Context sharing**: Supports Node-RED flow and global context

### Flow Patterns
- **Batch processing**: Process multiple images with same color mapping
- **Interactive visualization**: Real-time mask overlay for user interfaces
- **Analysis pipelines**: Combine with other image processing for complex workflows
