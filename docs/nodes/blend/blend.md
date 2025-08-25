# Blend Node

## Purpose & Use Cases

The `blend` node combines two images using alpha blending techniques, allowing for sophisticated image compositing with adjustable opacity and advanced blending options. It supports transparent overlays, background removal, and color-based compositing.

**Real-World Applications:**
- **Watermark Application**: Add semi-transparent logos or watermarks to photos
- **Background Replacement**: Composite subjects onto new backgrounds with proper edge blending
- **Artistic Effects**: Create double exposures and artistic blended compositions
- **Product Photography**: Combine product shots with environmental backgrounds
- **UI/UX Design**: Create layered interface elements with transparency effects

![Blend Demo](../../../assets/nodes/blend/blend-demo.gif)
*[PLACEHOLDER - Add GIF showing various blending operations including opacity, transparency, and color removal]*

## Input/Output Specification

### Inputs
- **Base Image**: Background or primary image (usually from `msg.payload.image1`)
- **Overlay Image**: Foreground or secondary image (usually from `msg.payload.image2`)
- **Blend Parameters**: Opacity and compositing settings via configuration or message properties

### Outputs
- **Blended Image**: Composite result of blending both input images
- **Preserved Dimensions**: Output maintains base image dimensions
- **Format Options**: Raw image object or encoded file formats

## Configuration Options

### Input Paths
- **Image 1 Path**: Location of base/background image (default: `msg.payload.image1`)
- **Image 2 Path**: Location of overlay/foreground image (default: `msg.payload.image2`)
- **Path Sources**: `msg.*`, `flow.*`, `global.*`

### Output Configuration
- **Output Path**: Where to store blended result (default: `msg.payload`)
- **Output Format**: Raw, JPEG, PNG, or WebP
- **Quality Settings**: Compression quality for lossy formats

### Blending Parameters

#### Opacity Control
- **Range**: 0-100% (0 = invisible overlay, 100 = opaque overlay)
- **Default**: 50% for balanced blending
- **Use Cases**: Watermarks (10-30%), artistic effects (40-70%), overlays (80-95%)

#### Advanced Blending Options

##### Alpha Compositing
- **Enable/Disable**: Use alpha channel information for proper transparency handling
- **Benefit**: Preserves transparency in PNG images and handles edge feathering
- **Use Case**: Professional compositing with transparent overlays

##### Background Removal
- **Enable/Disable**: Remove specific background colors from overlay image
- **Background Color**: Color to remove (hex, RGB, or named color)
- **Color Tolerance**: How closely colors must match for removal (0-100%)
- **Use Case**: Green screen compositing, product photography

### Output Format Options
- **Raw**: Standard image object (fastest for processing chains)
- **JPEG**: Compressed (transparency flattened to white)
- **PNG**: Full transparency preservation
- **WebP**: Modern format with transparency and compression

## Performance Notes

### C++ Backend Processing
- **Optimized Alpha Blending**: Hardware-accelerated blending algorithms
- **Color Space Handling**: Proper color space management for accurate blending
- **Memory Efficient**: In-place blending operations where possible
- **Edge Handling**: High-quality edge processing for smooth compositing

### Image Requirements
- **Dimension Handling**: Overlay automatically scaled/positioned to match base image
- **Color Space**: Both images converted to compatible color spaces for blending
- **Alpha Channel**: Proper alpha channel handling for transparency effects

## Real-World Examples

### Watermark Application
```
[Photo] → [Set as image1] ┐
[Logo] → [Set as image2]  ├→ [Blend: 20% opacity] → [Watermarked Photo]
```
Add semi-transparent watermarks to protect image copyrights.

### Background Replacement
```
[Subject Photo] → [Set as image2] ┐
[New Background] → [Set as image1] ├→ [Blend: Background removal, Green] → [Composite]
```
Replace green screen backgrounds with new environments.

### Artistic Double Exposure
```
[Portrait] → [Set as image1] ┐
[Texture] → [Set as image2] ├→ [Blend: 60% opacity, Alpha compositing] → [Artistic Effect]
```
Create artistic double exposure effects.

### Product Lifestyle Shots
```
[Product Photo] → [Set as image2] ┐
[Lifestyle Scene] → [Set as image1] ├→ [Blend: 85% opacity, Alpha] → [Lifestyle Product Shot]
```
Composite products into lifestyle environments.

### UI Element Creation
```
[Background] → [Set as image1] ┐
[UI Overlay] → [Set as image2] ├→ [Blend: 90% opacity, Alpha] → [UI Component]
```
Create layered interface elements with proper transparency.

## Common Issues & Troubleshooting

### Color Matching Problems
- **Issue**: Colors don't blend as expected
- **Solution**: Ensure both images use compatible color spaces
- **Check**: Verify image formats and color profiles

### Transparency Issues
- **Issue**: Transparent areas become white or black
- **Solution**: Enable alpha compositing and use PNG output format
- **Requirement**: Overlay image must have actual alpha channel data

### Background Removal Artifacts
- **Issue**: Incomplete or over-aggressive background removal
- **Solution**: Adjust color tolerance settings and background color specification
- **Optimization**: Use high-quality source images with clean backgrounds

### Dimension Mismatches
- **Issue**: Overlay doesn't align properly with base image
- **Behavior**: Overlay automatically scaled to match base image dimensions
- **Control**: Pre-resize images if specific positioning needed

### Performance with Large Images
- **Issue**: Slow blending with high-resolution images
- **Optimization**: Resize images to appropriate output size before blending
- **Memory**: Monitor memory usage with very large images

## Integration Patterns

### Watermarking Workflow
```
Content Image → Resize → Position Watermark → Blend → Protected Image
```
Standard content protection workflow.

### Compositing Pipeline  
```
Background → Color Correction → Subject → Background Removal → Blend → Final Composite
```
Professional compositing workflow.

### Batch Watermarking
```
Image Array → Individual Blending → Watermark Application → Protected Collection
```
Process multiple images with consistent watermarking.

### Multi-Layer Composition
```
Base → Blend with Layer 1 → Blend with Layer 2 → Blend with Layer 3 → Final Result
```
Build complex compositions with multiple layers.

## Advanced Usage

### Dynamic Opacity Based on Content
```javascript
// In function node before blend:
if (msg.imageType === 'portrait') {
  msg.blendOpacity = 25; // Subtle watermark for portraits
} else if (msg.imageType === 'landscape') {
  msg.blendOpacity = 40; // More visible for landscapes
} else {
  msg.blendOpacity = 30; // Default opacity
}
```

### Smart Background Color Detection
```javascript
// Detect and set background removal color
const dominantColor = msg.backgroundAnalysis.dominantColor;
msg.backgroundRemovalColor = dominantColor;
msg.colorTolerance = 15; // Adjust based on background uniformity
```

### Conditional Alpha Compositing
```javascript
// Enable alpha compositing only when overlay has transparency
if (msg.overlay.channels === 4) { // RGBA
  msg.useAlphaCompositing = true;
} else {
  msg.useAlphaCompositing = false;
}
```

### Quality-Based Blending
```javascript
// Adjust blend settings based on image quality requirements
if (msg.outputUse === 'print') {
  msg.outputFormat = 'png';
  msg.useAlphaCompositing = true;
} else if (msg.outputUse === 'web') {
  msg.outputFormat = 'webp';
  msg.outputQuality = 85;
} else {
  msg.outputFormat = 'raw'; // For further processing
}
```

## Best Practices

### Image Preparation
- Ensure both images are high quality for best blending results
- Use images with compatible aspect ratios when possible
- Pre-process images (color correction, sizing) before blending

### Opacity Selection
- **Watermarks**: 10-30% for subtle protection without distraction
- **Artistic Effects**: 40-70% for creative double exposures
- **Overlays**: 80-95% for prominent but layered appearance
- **Background Replacement**: Variable based on subject transparency

### Transparency Handling
- Use PNG format when transparency is important
- Enable alpha compositing for professional results
- Test transparency appearance in final display context

### Background Removal
- Use clean, uniform backgrounds for best removal results
- Start with lower tolerance and increase if needed
- Consider edge feathering for smoother compositing

### Performance Optimization
- Resize images to final output dimensions before blending
- Use raw format for processing chains
- Monitor memory usage with large images
- Consider batch processing strategies for multiple images

### Quality Considerations
- Use appropriate output format for final destination
- Consider compression settings for web vs. print use
- Test blending results in intended viewing context
- Maintain backup of original images before processing