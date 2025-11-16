# Image-Align Node (Ultra-Fast Image Alignment)

## Purpose & Use Cases

The `image-align` node provides ultra-fast image alignment using OpenCV's Enhanced Correlation Coefficient (ECC) algorithm. It aligns a target image to match the position and orientation of a reference image, correcting for translation shifts and minor rotations. This is essential for computer vision workflows requiring precise image registration.

**Real-World Applications:**
- **Medical Imaging**: Align sequential scans or multi-modal medical images for comparison
- **Quality Control**: Register product images for defect detection and comparison analysis
- **Surveillance Systems**: Align camera feeds for motion detection and background subtraction
- **Scientific Imaging**: Register microscopy images, satellite imagery, or astronomical photos
- **Document Processing**: Align scanned documents for OCR and content analysis
- **Augmented Reality**: Register camera feeds with reference markers for AR overlay
- **Time-Lapse Photography**: Stabilize sequences by aligning frames to eliminate camera shake

*[PLACEHOLDER - Add GIF showing before/after alignment of two shifted images]*

## Input/Output Specification

### Inputs
The node expects a message containing two images at configurable paths:
- **Reference Image**: The target image to align to (template)
- **Target Image**: The image to be aligned (moved to match reference)

### Input Format
Both images should follow the standard image object format:
```javascript
{
  data: Buffer,        // Raw pixel data
  width: number,       // Image width in pixels  
  height: number,      // Image height in pixels
  channels: number,    // Channel count (1, 3, 4)
  colorSpace: string,  // "GRAY", "RGB", "RGBA", "BGR", "BGRA"
  dtype: string        // "uint8" (standard)
}
```

### Outputs
```javascript
{
  payload: ImageObject,     // Aligned image (target aligned to reference)
  alignment: {
    success: boolean,       // Whether alignment succeeded
    timing: {
      convertMs: number,    // Image conversion time
      taskMs: number,       // Alignment processing time
      encodeMs: number      // Output encoding time (if not raw)
    },
    preset: string,         // Alignment preset used
    transformMatrix: {      // Optional: only when returnMatrix enabled
      dx: number,           // Horizontal translation in pixels
      dy: number,           // Vertical translation in pixels
      matrix2x3: [          // OpenCV 2x3 affine matrix format
        a, b, dx,           // [a b dx]
        c, d, dy            // [c d dy] where typically a=d=1, b=c=0 for translation
      ],
      matrix3x3: [          // Standard 3x3 homogeneous transformation matrix
        a, b, dx,           // [a  b  dx]
        c, d, dy,           // [c  d  dy]
        0, 0, 1             // [0  0  1 ] (homogeneous coordinates)
      ],
      transform: []         // Alias for matrix3x3 (backward compatibility)
    }
  }
}
```

## Configuration Options

### Input Configuration
- **Reference Image Path**: Location of reference image (default: `payload.reference`)
- **Target Image Path**: Location of target image (default: `payload.target`)  
- **Path Sources**: Support for `msg.*`, `flow.*`, `global.*` contexts

### Output Configuration
- **Output Path**: Where to store aligned image (default: `payload`)
- **Output Format**: Raw, JPEG, PNG, or WebP
- **Output Quality**: Compression quality for JPEG/WebP (1-100, default: 90)
- **PNG Optimization**: Enable PNG compression optimization

### Alignment Settings

#### Speed Presets
The node offers four carefully tuned presets balancing speed and accuracy:

**Ultra-Fast (Default)**
- **Scale**: 0.2 (20% resolution for alignment calculation)
- **Max Iterations**: 10
- **Termination Epsilon**: 1e-1
- **Use Case**: Real-time processing, minor alignment corrections
- **Processing Time**: ~5-15ms per image pair

**Fast**
- **Scale**: 0.3 (30% resolution)  
- **Max Iterations**: 20
- **Termination Epsilon**: 1e-2
- **Use Case**: Batch processing with moderate accuracy needs
- **Processing Time**: ~10-25ms per image pair

**Balanced**
- **Scale**: 0.5 (50% resolution)
- **Max Iterations**: 30  
- **Termination Epsilon**: 1e-3
- **Use Case**: General purpose alignment with good accuracy
- **Processing Time**: ~20-50ms per image pair

**Quality**
- **Scale**: 0.7 (70% resolution)
- **Max Iterations**: 50
- **Termination Epsilon**: 1e-4  
- **Use Case**: High precision alignment for critical applications
- **Processing Time**: ~40-100ms per image pair

**Custom**
- **Scale**: User-defined (0.1-1.0) - Image downscale factor for alignment calculation
- **Max Iterations**: User-defined (1-200) - Maximum number of ECC iterations
- **Termination Epsilon**: User-defined (0.000001-0.1) - Convergence threshold
- **Use Case**: Fine-tuned performance for specific image types or requirements
- **Processing Time**: Depends on parameters chosen

### Advanced Options
- **Return Matrix**: Enable transformation matrix output for analysis
- **Debug Mode**: Enable image preview display for development
- **Debug Width**: Preview image width (default: 200 pixels)

## Algorithm Details

### Enhanced Correlation Coefficient (ECC)
The node uses OpenCV's `findTransformECC()` with translation-only motion model for optimal speed:

1. **Preprocessing**: Convert both images to grayscale for alignment calculation
2. **Downsampling**: Scale images by preset factor for faster processing  
3. **ECC Registration**: Find optimal translation transformation using iterative ECC algorithm
4. **Upscaling**: Scale transformation matrix back to full resolution
5. **Application**: Apply transformation to original color target image
6. **Output**: Return aligned target image matching reference position

### Motion Model
- **Translation Only**: Corrects for X/Y shifts (most common alignment need)
- **Benefits**: Faster processing, more stable than full affine transformation
- **Limitations**: Cannot correct rotation, scaling, or perspective distortion

### Performance Optimizations
- **Multi-threaded**: Leverages OpenCV's parallel processing capabilities
- **Memory Efficient**: Processes images in-place where possible
- **Adaptive Scaling**: Automatic resolution reduction for speed without quality loss
- **Early Termination**: Stops iteration when convergence criteria met

## Performance Notes

### C++ Backend Processing
- **OpenCV ECC**: Professional-grade image registration algorithm
- **Async Processing**: Non-blocking execution with timing metrics
- **Memory Management**: Efficient buffer handling between JS/C++ layers
- **Error Recovery**: Graceful fallback if alignment fails

### Speed Characteristics
- **Ultra-Fast Preset**: 5-15ms processing time, suitable for real-time workflows
- **Quality Preset**: 40-100ms processing time for precision alignment
- **Batch Processing**: Parallel execution support for multiple image pairs
- **Scalability**: Linear performance scaling with image resolution

### Memory Usage
- **Temporary Buffers**: ~2-3x source image memory during processing
- **Optimization**: Automatic cleanup after processing completion
- **Large Images**: Consider downsampling very large images for speed

## Real-World Examples

### Medical Image Registration
```
[MRI Scan T1] + [MRI Scan T2] → [Image-Align: quality] → [Registered T2] → [Comparison Analysis]
```
Align multi-modal medical images for accurate comparison and analysis.

### Quality Control System  
```
[Reference Product] + [Test Product] → [Image-Align: balanced] → [Aligned Test] → [Defect Detection]
```
Register product images for precise defect detection and quality analysis.

### Surveillance Motion Detection
```
[Background Reference] + [Current Frame] → [Image-Align: ultra-fast] → [Stabilized Frame] → [Motion Analysis]  
```
Stabilize camera feeds for accurate motion detection and tracking.

### Document Processing
```
[Template Document] + [Scanned Document] → [Image-Align: fast] → [Registered Scan] → [OCR Processing]
```
Align scanned documents with templates for improved OCR accuracy.

### Scientific Imaging
```
[Reference Microscopy] + [Sample Image] → [Image-Align: quality] → [Registered Sample] → [Analysis Pipeline]
```  
Register scientific images for precise measurement and comparison.

## Common Issues & Troubleshooting

### Alignment Failures
- **Issue**: `alignment.success = false` in output
- **Causes**: Images too different, poor lighting, insufficient features
- **Solutions**: Try different preset, improve image quality, use more similar reference

### Poor Alignment Quality
- **Issue**: Images appear misaligned despite success=true
- **Causes**: Complex transformations beyond translation, low image contrast
- **Solutions**: Use Quality preset, improve image preprocessing, verify motion model suitability

### Performance Issues
- **Issue**: Slow processing times
- **Causes**: Large images, complex patterns, high-quality presets
- **Solutions**: Use Ultra-Fast preset, downsample large images, optimize image quality

### Memory Problems
- **Issue**: Out of memory errors with large images
- **Causes**: Very high resolution images, insufficient system memory
- **Solutions**: Downsample images, process in batches, increase system memory

### Format Compatibility
- **Issue**: Alignment fails with certain image formats
- **Causes**: Unsupported color spaces, unusual bit depths
- **Solutions**: Convert to standard formats, verify image structure

## Integration Patterns

### Computer Vision Pipeline
```
Image Capture → Preprocessing → Image-Align → Feature Extraction → Analysis
```
Standard computer vision workflow with image stabilization.

### Quality Inspection System
```
Reference Capture → Product Capture → Image-Align → Difference Analysis → Pass/Fail
```
Automated quality control with precise image registration.

### Medical Imaging Workflow  
```
Reference Scan → Patient Scan → Image-Align → Comparative Analysis → Diagnosis Support
```
Medical image registration for diagnostic comparison.

### Document Processing Pipeline
```
Template Scan → Document Scan → Image-Align → OCR Processing → Content Extraction
```
Document alignment for improved text recognition.

## Advanced Usage

### Dynamic Preset Selection
```javascript
// In function node before image-align:
// Choose preset based on image characteristics
const imageSize = msg.payload.reference.width * msg.payload.reference.height;
if (imageSize > 2000000) { // Large images
  msg.alignmentPreset = 'ultra-fast';
} else if (msg.criticalAccuracy) {
  msg.alignmentPreset = 'quality';  
} else {
  msg.alignmentPreset = 'balanced';
}
```

### Custom Parameters for Fine-Tuning
```javascript
// Configure image-align node with custom preset for specific use case
const nodeConfig = {
  preset: 'custom',
  customScale: 0.4,           // Medium resolution for balance
  customMaxIterations: 25,    // Moderate iterations
  customTerminationEps: 5e-3  // Balanced convergence threshold
};

// Example: High-precision alignment for microscopy images
const microscopeConfig = {
  preset: 'custom',
  customScale: 0.8,           // High resolution to capture fine details
  customMaxIterations: 75,    // More iterations for precision
  customTerminationEps: 1e-5  // Very strict convergence
};

// Example: Ultra-fast alignment for video frames
const videoConfig = {
  preset: 'custom',
  customScale: 0.15,          // Very low resolution for speed
  customMaxIterations: 5,     // Minimal iterations
  customTerminationEps: 0.05  // Loose convergence for speed
};
```

### Batch Processing Pattern
```javascript
// Process multiple image pairs with consistent reference
msg.imageQueue.forEach((target, index) => {
  msg.payload = {
    reference: msg.referenceImage, // Consistent reference
    target: target // Different target for each
  };
  // Send to image-align node
});
```

### Quality Validation
```javascript  
// After image-align node:
if (msg.alignment.success && msg.alignment.timing.taskMs < 100) {
  // Alignment succeeded and was fast - good quality match
  msg.qualityScore = 'excellent';
} else if (msg.alignment.success) {
  // Alignment succeeded but slow - challenging alignment
  msg.qualityScore = 'good';
} else {
  // Alignment failed - images too different
  msg.qualityScore = 'poor';
  // Consider fallback processing
}
```

### Performance Monitoring
```javascript
// Track alignment performance over time
if (!flow.get('alignmentStats')) {
  flow.set('alignmentStats', { total: 0, successful: 0, avgTime: 0 });
}

const stats = flow.get('alignmentStats');
stats.total++;
if (msg.alignment.success) {
  stats.successful++;
}
stats.avgTime = (stats.avgTime * (stats.total - 1) + msg.alignment.timing.taskMs) / stats.total;
flow.set('alignmentStats', stats);

msg.performanceStats = {
  successRate: stats.successful / stats.total,
  averageTime: stats.avgTime
};
```

### Transformation Matrix Analysis
```javascript
// After image-align node with returnMatrix enabled:
if (msg.alignment.success && msg.alignment.transformMatrix) {
  const matrix = msg.alignment.transformMatrix;
  
  // Simple translation values
  node.log(`Image shifted by dx: ${matrix.dx}, dy: ${matrix.dy} pixels`);
  
  // Access different matrix formats
  const opencv2x3 = matrix.matrix2x3;  // [a, b, dx, c, d, dy]
  const homogeneous3x3 = matrix.matrix3x3;  // [a, b, dx, c, d, dy, 0, 0, 1]
  const transform = matrix.transform;  // Same as matrix3x3
  
  // Analyze alignment quality
  const totalShift = Math.sqrt(matrix.dx * matrix.dx + matrix.dy * matrix.dy);
  if (totalShift < 5) {
    msg.alignmentQuality = 'excellent';
  } else if (totalShift < 20) {
    msg.alignmentQuality = 'good';
  } else {
    msg.alignmentQuality = 'poor';
  }
  
  // Store for applying to other images
  flow.set('lastAlignment', matrix);
}
```

### Applying Transformation to Other Images
```javascript
// Use stored transformation matrix to align additional images
const storedMatrix = flow.get('lastAlignment');
if (storedMatrix && msg.additionalImages) {
  msg.additionalImages.forEach((image, index) => {
    // Note: You would need a custom transformation function or another alignment node
    // The matrix provides the exact translation values needed
    msg.transformationNeeded = {
      dx: storedMatrix.dx,
      dy: storedMatrix.dy
    };
  });
}
```

## Best Practices

### Image Preparation
- Use images with sufficient contrast and distinctive features
- Ensure reasonable similarity between reference and target images
- Consider preprocessing (histogram equalization, noise reduction) for challenging images
- Maintain consistent lighting conditions when possible

### Performance Optimization  
- Start with Ultra-Fast preset and upgrade only if accuracy insufficient
- Downsample very large images (>4MP) before alignment if possible
- Use Raw output format for processing chains to avoid encoding overhead
- Monitor timing metrics to optimize preset selection

### Quality Control
- Always check `alignment.success` flag before using results
- Implement fallback behavior for alignment failures
- Monitor processing times to detect performance degradation
- Validate alignment quality using automated metrics when possible

### Error Handling
- Implement graceful handling of alignment failures
- Provide meaningful feedback for different failure modes
- Log alignment statistics for system monitoring
- Consider retry logic with different presets for critical applications

### Integration Strategy
- Design workflows to handle both successful and failed alignments
- Implement quality scoring based on timing and success metrics  
- Consider batch processing patterns for efficiency with multiple images
- Plan for scalability based on expected image volumes and quality requirements

### Debug and Development
- Enable debug mode during development for visual verification
- Use timing metrics to optimize preset selection for your use case
- Test with representative image pairs from your target domain
- Validate alignment quality using domain-specific metrics
