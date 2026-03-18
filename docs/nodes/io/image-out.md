# Image-Out Node

## Purpose & Use Cases

The `image-out` node is the primary output point for saving processed images to the filesystem from Node-RED flows. It features automatic timestamp-based naming, overwrite protection, and flexible format conversion, making it ideal for production workflows.

**Real-World Applications:**
- **Automated Image Processing**: Save processed images with organized timestamp naming
- **Computer Vision Results**: Export detected objects or processed frames
- **Batch Processing Workflows**: Save multiple images without filename conflicts
- **Quality Control Systems**: Archive inspection images with automatic naming
- **Web Application Backends**: Save user-processed images with format optimization

## Input/Output Specification

### Inputs
The node accepts either:
- **Raw Image Object**: Standard format with `data`, `width`, `height`, `channels`, `colorSpace`
- **Encoded Buffer**: JPEG, PNG, or WebP buffer (automatically detected and handled). Note: BMP output is not supported from encoded buffers — use raw image objects instead.

### Outputs
This is a terminal node with no outputs. It saves images to the filesystem and displays status information.

### Button Control
- **Right-side button**: Toggle node active/inactive state (similar to debug node)
- **Green**: Active and saving images
- **Gray**: Inactive (passes through without saving)

## Configuration Options

### Folder Path
- **Type**: String | msg | flow | global (required)
- **Description**: Directory where images will be saved
- **Options**:
  - **String**: Static path (e.g., `/home/user/output/`)
  - **msg.***: Dynamic path from message (e.g., `msg.folder`)
  - **flow.***: Path from flow context
  - **global.***: Path from global context
- **Auto-creation**: Directory is created if it doesn't exist

### Filename Prefix
- **Type**: String (optional)
- **Default**: "image"
- **Description**: Custom prefix for generated filenames
- **Pattern**: `[prefix]_YYYYMMDD_HHMMSS.[ext]`
- **Example**: With prefix "webcam" → `webcam_20240109_143022.jpg`

### Input From
- **Default**: `msg.payload`
- **Options**: Any message property, flow, or global variable
- **Accepts**: Both raw image objects and encoded buffers

### Output Format
- **Options**: JPEG, PNG, WebP, BMP
- **Description**: Target format for saved images
- **Conversion**: Automatic conversion if input format differs
- **BMP**: Uncompressed format with no quality/compression settings. Requires raw image data input.

### Quality
- **Type**: Number (1-100)
- **Default**: 90
- **Applies to**: JPEG and WebP formats
- **Description**: Higher values = better quality but larger files

### PNG Optimize
- **Type**: Boolean
- **Default**: false
- **Description**: Maximum compression for PNG files (slower but smaller)

### Overwrite Protection
- **Type**: Boolean
- **Default**: true
- **Description**: Automatically appends `_2`, `_3`, etc. to prevent overwriting
- **Example**: If `image_20240109_143022.jpg` exists, saves as `image_20240109_143022_2.jpg`

### Debug Preview
- **Type**: Boolean
- **Default**: false
- **Description**: Shows saved image preview on the node

## Performance & Technical Details

### Timestamp Naming
Files are automatically named with timestamps:
- **Format**: `YYYYMMDD_HHMMSS`
- **Example**: `image_20240109_143022.jpg`
- **Benefits**: Chronological ordering, no conflicts, easy sorting

### Format Handling
The node intelligently handles format conversions:
- **Same Format**: Direct save without re-encoding (fastest)
- **Different Format**: Automatic conversion using Sharp
- **Raw to Encoded**: Full processing with color space handling
- **Encoded to Encoded**: Smart re-encoding only when needed

### Status Indicators
- **Gray dot "inactive"**: Node disabled via button
- **Blue dot "saving..."**: Currently writing to disk
- **Green dot "saved: filename.jpg"**: Success with filename
- **Red dot "Error"**: Save failed (check debug panel)

## Error Handling

Common errors and solutions:
- **"Folder path not configured"**: Ensure folder path is set
- **"Invalid image structure"**: Check input is valid image data
- **"Cannot create directory"**: Verify write permissions
- **"Too many file variations"**: Clean up old files (>1000 with same timestamp)

## Examples

### Basic Save with Timestamp
```javascript
// Input: Processed image
// Config: Folder="/output", Format="jpg"
// Result: /output/image_20240109_143022.jpg
```

### Custom Prefix for Source Identification
```javascript
// Config: Prefix="camera1", Folder="/surveillance"
// Result: /surveillance/camera1_20240109_143022.jpg
```

### Format Conversion
```javascript
// Input: PNG buffer
// Config: Format="webp", Quality=80
// Result: Converts PNG to WebP with 80% quality
```

### Dynamic Folder from Message
```javascript
// msg.saveFolder = "/output/batch1"
// Config: Folder from msg.saveFolder
// Result: Saves to dynamic folder location
```

### Overwrite Protection in Action
```javascript
// First save: image_20240109_143022.jpg
// Second save (same second): image_20240109_143022_2.jpg
// Third save: image_20240109_143022_3.jpg
```

## Tips & Best Practices

1. **Use Prefixes**: Identify image sources with meaningful prefixes
2. **Enable Protection**: Keep overwrite protection on to prevent data loss
3. **Choose Format Wisely**:
   - JPEG for photos (smaller files)
   - PNG for graphics with transparency
   - WebP for web optimization
   - BMP for uncompressed archival or when lossless pixel-exact output is needed
4. **Button Control**: Disable during development to prevent unwanted saves
5. **Monitor Status**: Check node status for save confirmations

## Integration Examples

### Computer Vision Pipeline
```
[Camera] → [Object Detection] → [Draw Boxes] → [Image-Out]
```
Save annotated detection results with timestamps.

### Batch Processing
```
[Image-In] → [Array-Out] → [Transform] → [Image-Out]
```
Process and save multiple images with automatic naming.

### Quality Control
```
[Inspection Camera] → [Defect Detection] → [Image-Out (active/inactive)]
```
Conditionally save images based on detection results.

## Related Nodes
- **[image-in](image-in.md)**: Load images from filesystem
- **[array-out](array-out.md)**: Process multiple images before saving
- **[filter](../transform/filter.md)**: Apply enhancements before saving