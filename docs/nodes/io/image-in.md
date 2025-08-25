# Image-In Node

## Purpose & Use Cases

The `image-in` node is the primary entry point for loading images from the filesystem into Node-RED flows. It converts image files into the standardized image object format used throughout the Rosepetal Image Tools ecosystem.

**Real-World Applications:**
- **Photo Processing Workflows**: Load photos for batch editing and enhancement
- **Computer Vision Pipelines**: Import images for AI/ML analysis and object detection
- **Web Content Processing**: Load user-uploaded images for processing before storage
- **Surveillance Systems**: Import images from cameras or storage for analysis
- **Medical Imaging**: Load diagnostic images for processing and analysis

![Image-In Demo](../../../assets/nodes/io/image-in-demo.gif)
*[PLACEHOLDER - Add GIF showing image loading with different file formats]*

## Input/Output Specification

### Inputs
- **msg.payload** (any): Input message that triggers the node (content ignored)
- **msg.filePath** (string, optional): Dynamic file path override

### Outputs
The node outputs a standardized image object to the configured location:

```javascript
{
  data: Buffer,        // Raw pixel data  
  width: number,       // Image width in pixels
  height: number,      // Image height in pixels
  channels: number,    // Channel count (1=grayscale, 3=RGB, 4=RGBA)
  colorSpace: string,  // "GRAY", "RGB", "RGBA"
  dtype: string        // "uint8" (standard)
}
```

## Configuration Options

### File Path
- **Type**: String (required)
- **Description**: Absolute or relative path to the image file
- **Supported Formats**: All formats supported by Sharp (JPEG, PNG, WebP, BMP, TIFF, GIF, SVG, and more)
- **Example**: `/home/user/photos/image.jpg` or `./images/photo.png`
- **Dynamic**: Can be overridden via `msg.filePath`

### Output Location
- **Default**: `msg.payload`
- **Options**: 
  - `msg.*` - Store in message property
  - `flow.*` - Store in flow context 
  - `global.*` - Store in global context
- **Use Case**: Choose based on how you want to access the image downstream

## Performance Notes

### Sharp (libvips) Backend Optimization
- **High-Speed Loading**: Uses Sharp (libvips) for optimized image decoding
- **Async Processing**: Non-blocking operation with performance timing display
- **Memory Efficient**: Optimized for large images and batch processing
- **Metadata Extraction**: Complete image properties extracted during load

### Status Display
The node shows real-time progress and results:
- **Blue dot**: Reading file
- **Green dot**: Success with dimensions and timing info
- **Red ring**: Error with file access or format issues

## Real-World Examples

### Basic Photo Import
```
[Inject] → [Image-In: /photos/vacation.jpg] → [Debug]
```
Load a single photo and inspect its properties.

### Dynamic File Loading
```
[File List] → [Image-In: msg.filePath] → [Resize] → [Save]
```
Process multiple files by passing file paths through messages.

### Computer Vision Pipeline
```
[Image-In] → [CropBB] → [Filter] → [Analysis]
```
Load images for object detection and post-processing.

### Batch Processing Setup
```
[Image-In] → [Array-In] → [Array-Out] → [Batch Transform]
```
Collect multiple images into arrays for parallel processing.

## Common Issues & Troubleshooting

### File Access Problems
- **Issue**: "Cannot access file" warning
- **Solution**: Verify file path exists and Node-RED has read permissions
- **Check**: Use absolute paths to avoid relative path confusion

### Unsupported Format
- **Issue**: Node fails silently or errors
- **Solution**: Ensure file is in supported format (JPEG, PNG, WebP, BMP)
- **Check**: Verify file isn't corrupted using image viewer

### Memory Issues
- **Issue**: Large images cause performance problems
- **Solution**: Process images in batches, consider resizing after load
- **Optimization**: Use flow/global context for sharing large images

### Path Configuration
- **Static Path**: Set in node configuration for fixed file locations
- **Dynamic Path**: Use `msg.filePath` for runtime file selection
- **Best Practice**: Validate paths before processing

## Integration Patterns

### With Transform Nodes
```
Image-In → Resize → Rotate → Crop → Filter
```
Standard image processing pipeline.

### With Array Management
```
Image-In → Array-In (collect) → Array-Out → Batch Process
```
Aggregate multiple images for batch operations.

### With Computer Vision
```
Image-In → AI Detection → CropBB → Analysis
```
Load images for machine learning workflows.

### With Output Nodes
```
Image-In → Process → Encode → File Write
```
Complete image processing and save workflow.