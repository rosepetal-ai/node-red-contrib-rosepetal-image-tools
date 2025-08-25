# Add-Mask Node

## Purpose & Use Cases

The `add-mask` node applies polygon-based masks to images using coordinate arrays to define masked regions. It creates weighted blending effects within polygon boundaries, perfect for selective image modifications and region-based processing from AI detection or manual selection.

**Real-World Applications:**
- **AI Object Masking**: Apply masks from AI detection results with polygon coordinates
- **ROI Processing**: Highlight or modify regions of interest defined by coordinate boundaries  
- **Selective Enhancement**: Apply effects only within specific geometric areas
- **Quality Control**: Overlay inspection results on products using detected boundaries
- **Medical Analysis**: Highlight detected anomalies or structures with polygon masks

![Add-Mask Demo](../../../assets/nodes/blend/add-mask-demo.gif)
*[PLACEHOLDER - Add GIF showing various masking operations including product cutouts and artistic effects]*

## Input/Output Specification

### Inputs
- **Base Image**: The image to which the polygon mask will be applied
- **Polygon Coordinates**: Array of [x, y] coordinate pairs defining mask boundary
- **Mask Parameters**: Strength and fill color via configuration

### Outputs
- **Masked Image**: Original image with weighted blending applied within polygon area
- **Selective Processing**: Areas within polygon receive mask treatment based on strength setting
- **Format Options**: Raw image object or encoded file formats

## Configuration Options

### Input Paths
- **Image Path**: Location of base image to mask (default: `msg.payload.image`)
- **Polygon Path**: Location of coordinate array (default: `msg.payload.default.masks[0].mask[0]`)  
- **Path Sources**: `msg.*`, `flow.*`, `global.*`

### Output Configuration
- **Output Path**: Where to store masked result (default: `msg.payload`)
- **Output Format**: Raw, JPEG, PNG, WebP
- **Quality Settings**: Compression settings for lossy formats

### Polygon Mask Options

#### Coordinate System
- **Normalized Coordinates**: All coordinates must be in range [0, 1]
- **Format**: Array of [x, y] pairs: `[[x1,y1], [x2,y2], [x3,y3], ...]`
- **Relative Positioning**: 0.0 = left/top edge, 1.0 = right/bottom edge

#### Mask Strength
- **Range**: 0-100% (0 = no effect, 100 = maximum blending)
- **Default**: 50% for balanced effect
- **Purpose**: Controls intensity of mask blending within polygon

#### Fill Color
- **Format**: Hex color code (e.g., `#FF0000` for red)
- **Default**: White (`#FFFFFF`)
- **Purpose**: Color used for blending within masked polygon area

### Output Format Options
- **Raw**: Standard image object with alpha channel
- **PNG**: Full transparency preservation (recommended)
- **WebP**: Modern format with transparency support
- **JPEG**: Not recommended (transparency becomes background color)

## Performance Notes

### C++ Backend Processing
- **Optimized Alpha Processing**: Fast alpha channel manipulation
- **Edge Smoothing**: High-quality anti-aliasing for smooth mask edges
- **Memory Efficient**: Direct alpha channel writing without full image copying
- **Format Handling**: Proper handling of different input mask formats

### Mask Processing Algorithms
- **Grayscale Conversion**: Efficient luminance-to-alpha conversion
- **Edge Detection**: Smart edge smoothing for professional results
- **Threshold Processing**: Fast binary mask generation when needed

## Real-World Examples

### AI Object Detection Highlighting
```javascript
// AI detection provides polygon coordinates
msg.detectedObjects[0] = {
  polygon: [[0.1, 0.2], [0.8, 0.2], [0.8, 0.7], [0.1, 0.7]],
  confidence: 0.95
};
msg.payload.image = originalImage;
msg.payload.default.masks[0].mask[0] = msg.detectedObjects[0].polygon;
```
```
[Image + AI Polygons] → [Add-Mask: 30% red overlay] → [Highlighted Detections]
```

### Quality Control ROI
```javascript
// Define inspection region
msg.inspectionRegion = [
  [0.25, 0.25], [0.75, 0.25], 
  [0.75, 0.75], [0.25, 0.75]
];
```
```
[Product Image] → [Function: Set ROI] → [Add-Mask: 50% yellow] → [Inspection Overlay]
```

### Medical Annotation
```javascript  
// Radiologist defined region
msg.anomalyRegion = [
  [0.4, 0.3], [0.6, 0.3], [0.65, 0.5], 
  [0.6, 0.7], [0.4, 0.7], [0.35, 0.5]
];
```
```
[Medical Scan] → [Function: Set Polygon] → [Add-Mask: 40% red] → [Annotated Scan]
```

### Custom Selection Processing
```javascript
// User-defined polygon selection
msg.userSelection = [
  [0.0, 0.0], [1.0, 0.0], [1.0, 0.5], [0.0, 0.5]
]; // Top half of image
```
```
[Image] → [Function: Set Selection] → [Add-Mask: 70% blue tint] → [Selective Processing]
```

### Batch Region Processing
```
[Image Array] → [AI Detection] → [Extract Polygons] → [Add-Mask: Highlight] → [Processed Results]
```
Process multiple images with AI-detected regions.

## Common Issues & Troubleshooting

### Invalid Polygon Coordinates
- **Issue**: Error messages about invalid coordinate format or ranges
- **Solution**: Ensure coordinates are arrays of [x,y] pairs with values in [0,1] range
- **Format**: `[[0.1,0.2], [0.8,0.2], [0.8,0.7], [0.1,0.7]]`

### Empty or Missing Polygons
- **Issue**: No masking effect applied to image
- **Solution**: Verify polygon path contains valid coordinate array
- **Check**: Ensure polygon array is not empty and coordinates are properly formatted

### Polygon Outside Image Bounds
- **Issue**: Mask effect not visible or only partially applied
- **Cause**: Polygon coordinates outside [0,1] normalized range
- **Solution**: Validate all coordinates are between 0.0 and 1.0

### Incorrect Path Configuration
- **Issue**: Node cannot find image or polygon data
- **Solution**: Verify input paths match your message structure
- **Default Paths**: `msg.payload.image` and `msg.payload.default.masks[0].mask[0]`

### Weak or Invisible Mask Effects
- **Issue**: Mask blending barely visible on image
- **Solution**: Increase mask strength percentage or adjust fill color contrast
- **Optimization**: Use colors that contrast well with image content

## Integration Patterns

### E-commerce Product Processing
```
Product Photo → Background Detection → Generate Mask → Add-Mask → Clean Cutout
```
Automated product cutout generation for online catalogs.

### Portrait Enhancement Workflow
```
Portrait → Create Vignette → Add-Mask → Color Enhancement → Artistic Portrait
```
Professional portrait processing with masking effects.

### Logo Production Pipeline
```
Design → Shape Creation → Mask Generation → Add-Mask → Export Formats
```
Convert solid designs into transparent logo formats.

### Medical Analysis Pipeline
```
Scan → Region Detection → Mask Creation → Add-Mask → Analysis → Report
```
Medical imaging analysis with region masking.

## Advanced Usage

### Dynamic Mask Creation
```javascript
// Generate circular mask based on image dimensions
const width = msg.image.width;
const height = msg.image.height;
const radius = Math.min(width, height) / 3;

msg.maskType = 'circular';
msg.maskRadius = radius;
msg.maskCenter = { x: width/2, y: height/2 };
```

### Conditional Mask Processing
```javascript
// Apply different mask processing based on image type
if (msg.imageType === 'product') {
  msg.maskInversion = false;
  msg.smoothEdges = true;
  msg.featherAmount = 2;
} else if (msg.imageType === 'portrait') {
  msg.maskInversion = true; // Vignette mask
  msg.smoothEdges = true;
  msg.featherAmount = 5;
}
```

### Quality-Based Processing
```javascript
// Adjust processing based on output requirements
if (msg.outputUse === 'web') {
  msg.outputFormat = 'webp';
  msg.featherAmount = 1; // Minimal feathering for web
} else if (msg.outputUse === 'print') {
  msg.outputFormat = 'png';
  msg.featherAmount = 3; // More feathering for print
  msg.smoothEdges = true;
}
```

### Batch Mask Application
```javascript
// Apply same mask to multiple images
msg.images.forEach((img, index) => {
  img.maskSettings = {
    invert: false,
    smooth: true,
    feather: 2
  };
});
```

## Best Practices

### Mask Creation
- Create masks at same resolution as target images for best quality
- Use soft brushes or gradients for smooth edge transitions
- Test masks with sample images before batch processing
- Save masks as high-quality grayscale or alpha channel images

### Edge Quality
- Enable smooth edges for professional results
- Use appropriate feathering amounts (1-3 pixels for web, 2-5 for print)
- Consider anti-aliasing requirements for your final output
- Test edge quality at actual display size

### Format Selection
- **PNG**: Best for transparency preservation and quality
- **WebP**: Good compression with transparency support
- **Raw**: For continued processing chains
- **Avoid JPEG**: For images requiring transparency

### Performance Optimization
- Use appropriately sized masks (don't oversample)
- Process masks separately from color correction when possible
- Use raw format for processing chains
- Consider memory usage with large high-resolution images

### Quality Considerations
- Match mask resolution to target image resolution
- Use high-quality source masks without compression artifacts
- Test transparency results in final display context
- Consider edge quality requirements for intended use

### Production Workflow
- Maintain original images before masking
- Create standardized mask templates for consistent results
- Implement quality checks for edge smoothness
- Document mask settings for reproducible results