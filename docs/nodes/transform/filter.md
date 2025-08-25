# Filter Node

## Purpose & Use Cases

The `filter` node applies various image processing filters for enhancement, artistic effects, and image analysis. It provides optimized implementations of common filters including blur, sharpen, edge detection, emboss, and Gaussian operations.

**Real-World Applications:**
- **Photo Enhancement**: Sharpen portraits and improve image quality
- **Artistic Effects**: Create stylized images with emboss and edge effects
- **Quality Control**: Use edge detection to analyze product shapes and boundaries
- **Medical Imaging**: Enhance contrast and details in diagnostic images
- **Preprocessing**: Prepare images for AI analysis with noise reduction and enhancement

![Filter Demo](../../../assets/nodes/transform/filter-demo.gif)
*[PLACEHOLDER - Add GIF showing before/after results of different filter types]*

## Input/Output Specification

### Inputs
- **Single Image**: Standard image object format
- **Image Array**: Array of image objects for batch filtering
- **Dynamic Parameters**: Filter strength and settings via message properties

### Outputs
- **Filtered Image**: Image with applied filter effects
- **Preserved Dimensions**: Output maintains original image dimensions
- **Format Options**: Raw image object or encoded file formats

## Configuration Options

### Input/Output Paths
- **Input From**: `msg.payload` (default), `flow.*`, `global.*`
- **Output To**: `msg.payload` (default), `flow.*`, `global.*`

### Filter Types

#### Blur Filter
- **Purpose**: Reduces image noise and creates soft focus effects
- **Strength**: Configurable blur radius
- **Use Cases**: Noise reduction, background softening, privacy protection

#### Sharpen Filter  
- **Purpose**: Enhances image details and edge definition
- **Strength**: Configurable sharpening intensity
- **Use Cases**: Photo enhancement, print preparation, detail emphasis

#### Edge Detection
- **Purpose**: Highlights edges and boundaries in images
- **Output**: Binary or grayscale edge maps
- **Use Cases**: Object detection, shape analysis, contour extraction

#### Emboss Filter
- **Purpose**: Creates 3D relief effect with depth appearance
- **Direction**: Configurable embossing direction
- **Use Cases**: Artistic effects, texture analysis, decorative processing

#### Gaussian Blur
- **Purpose**: Smooth blur with natural falloff
- **Sigma**: Configurable standard deviation for blur amount
- **Use Cases**: Background blur, noise reduction, preprocessing

### Filter Strength/Parameters
- **Range**: Varies by filter type
- **Sources**: Number, `msg.*`, `flow.*`, `global.*`
- **Dynamic**: Runtime adjustment via message properties

### Output Format Options
- **Raw**: Standard image object (fastest for processing chains)
- **JPEG**: Compressed with quality control
- **PNG**: Lossless preservation of filter effects
- **WebP**: Modern format with excellent compression

## Performance Notes

### C++ Backend Processing
- **Optimized Kernels**: Hand-tuned convolution implementations
- **OpenCV Integration**: Leverages OpenCV's optimized filter functions
- **Memory Efficient**: In-place processing where possible
- **Parallel Execution**: Multi-threaded processing for large images

### Filter-Specific Performance
- **Blur/Gaussian**: Linear time complexity with kernel size
- **Sharpen**: Fast single-pass convolution
- **Edge Detection**: Sobel or Canny edge detection algorithms
- **Emboss**: Single convolution pass with directional kernel

## Real-World Examples

### Photo Enhancement Chain
```\n[Portrait Photo] → [Filter: Sharpen, Strength=1.2] → [Enhanced Portrait]\n```\nSharpen portrait photos for better print quality.\n\n### Artistic Effect Creation\n```\n[Landscape Photo] → [Filter: Emboss] → [Artistic Relief Effect]\n```\nCreate artistic embossed versions of photographs.\n\n### Object Detection Preprocessing\n```\n[Product Image] → [Filter: Edge Detection] → [Shape Analysis] → [Quality Control]\n```\nPrepare images for automated shape analysis.\n\n### Batch Photo Enhancement\n```\n[Photo Array] → [Filter: Gaussian Blur, Sigma=0.8] → [Noise Reduced Photos]\n```\nReduce noise across multiple photos simultaneously.\n\n### Multi-Stage Processing\n```\n[Raw Image] → [Filter: Gaussian] → [Filter: Sharpen] → [Filter: Edge] → [Analysis Ready]\n```\nApply multiple filters in sequence for complex processing.\n\n## Filter Descriptions & Applications\n\n### Blur Filter\n- **Algorithm**: Simple box blur or averaging\n- **Best For**: Quick noise reduction, privacy masking\n- **Strength Values**: 1-10 (higher = more blur)\n- **Performance**: Fastest blur option\n\n### Gaussian Blur\n- **Algorithm**: Gaussian weighted averaging  \n- **Best For**: Natural-looking blur, professional effects\n- **Sigma Values**: 0.5-5.0 (higher = more blur)\n- **Quality**: Superior visual quality compared to simple blur\n\n### Sharpen Filter\n- **Algorithm**: Unsharp mask or kernel sharpening\n- **Best For**: Enhancing photo details, print preparation\n- **Strength Values**: 0.5-2.0 (higher = more sharpening)\n- **Caution**: Excessive sharpening can create artifacts\n\n### Edge Detection\n- **Algorithm**: Sobel, Canny, or gradient-based\n- **Best For**: Shape analysis, object detection, boundary finding\n- **Output**: Usually grayscale edge map\n- **Applications**: Computer vision, quality inspection\n\n### Emboss Filter\n- **Algorithm**: Directional convolution kernel\n- **Best For**: Artistic effects, texture analysis\n- **Direction**: Usually northwest-to-southeast lighting\n- **Effect**: Creates 3D appearance with highlights and shadows\n\n## Common Issues & Troubleshooting\n\n### Over-Processing\n- **Issue**: Filters applied too strongly create artifacts\n- **Solution**: Use moderate strength values, preview results\n- **Prevention**: Start with low values and increase gradually\n\n### Performance with Large Images\n- **Issue**: Filtering very large images is slow\n- **Optimization**: Consider resizing before filtering if appropriate\n- **Alternative**: Use batch processing for multiple images\n\n### Color Channel Handling\n- **Issue**: Filters affecting color balance unexpectedly\n- **Solution**: Some filters work better on grayscale\n- **Consideration**: Convert to grayscale first for analysis filters\n\n### Filter Combination Effects\n- **Issue**: Multiple filters creating unwanted cumulative effects\n- **Solution**: Plan filter sequence carefully\n- **Best Practice**: Apply filters in logical order (blur → sharpen → edge)\n\n## Integration Patterns\n\n### Photo Enhancement Workflow\n```\nImage-In → Filter (Gaussian, light) → Filter (Sharpen, moderate) → Output\n```\nStandard photo enhancement with noise reduction and sharpening.\n\n### Computer Vision Preprocessing\n```\nImage → Filter (Gaussian) → Filter (Edge Detection) → AI Analysis\n```\nPrepare images for machine learning analysis.\n\n### Artistic Processing Chain\n```\nImage → Filter (Emboss) → Blend (with original) → Artistic Result\n```\nCreate artistic effects by combining filtered and original images.\n\n### Quality Control Pipeline\n```\nProduct Image → Filter (Edge) → Shape Analysis → Pass/Fail Decision\n```\nAutomated quality inspection using edge detection.\n\n## Advanced Usage\n\n### Adaptive Filtering\n```javascript\n// In a function node before filter:\nif (msg.imageNoise > 0.3) {\n  msg.filterType = 'gaussian';\n  msg.filterStrength = 1.5;\n} else {\n  msg.filterType = 'sharpen';\n  msg.filterStrength = 1.0;\n}\n```\n\n### Multi-Pass Enhancement\n```javascript\n// Progressive enhancement\nconst passes = [\n  { type: 'gaussian', strength: 0.5 },\n  { type: 'sharpen', strength: 1.2 },\n  { type: 'edge', strength: 1.0 }\n];\nmsg.filterPasses = passes;\n```\n\n### Conditional Processing\n```javascript\n// Apply different filters based on image characteristics\nif (msg.imageType === 'portrait') {\n  msg.filterType = 'sharpen';\n} else if (msg.imageType === 'landscape') {\n  msg.filterType = 'gaussian';\n} else {\n  msg.filterType = 'edge';\n}\n```\n\n## Best Practices\n\n### Filter Selection\n- **Photos**: Use Gaussian blur for noise, sharpen for enhancement\n- **Analysis**: Use edge detection for object recognition\n- **Artistic**: Use emboss for creative effects\n- **Preprocessing**: Use appropriate filter for downstream processing\n\n### Parameter Tuning\n- Start with conservative values and increase gradually\n- Preview results when possible to avoid over-processing\n- Consider image content when selecting strength values\n- Test with representative images before batch processing\n\n### Performance Optimization\n- Use raw format for filter chains to maintain speed\n- Process arrays when possible for batch efficiency\n- Consider image size vs. filter complexity trade-offs\n- Monitor processing times and optimize parameters accordingly\n\n### Quality Considerations\n- Apply filters in logical order (clean → enhance → analyze)\n- Avoid excessive filtering that degrades image quality  \n- Save original images before applying destructive filters\n- Use appropriate output formats for your final use case