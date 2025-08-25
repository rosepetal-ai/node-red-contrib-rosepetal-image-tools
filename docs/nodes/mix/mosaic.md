# Mosaic Node

## Purpose & Use Cases

The `mosaic` node provides manual positioning of multiple images on a canvas with precise coordinate control. It creates composite images by placing images at specific positions, supporting both normalized (0-1) and pixel coordinates for flexible layout creation.

**Real-World Applications:**
- **Custom Layouts**: Create precise image arrangements with exact positioning
- **Template-Based Designs**: Position images according to predefined layout templates  
- **Overlay Compositions**: Layer images at specific positions for complex compositions
- **Dashboard Assembly**: Position charts and data visualizations with pixel precision
- **Print Design**: Create exact layouts for brochures, posters, and marketing materials

![Mosaic Demo](../../../assets/nodes/mix/mosaic-demo.gif)
*[PLACEHOLDER - Add GIF showing various mosaic layouts with different grid sizes and spacing]*

## Input/Output Specification

### Inputs
- **Image Array**: Array of image objects to position on canvas
- **Position Configuration**: Position mappings defined in node configuration
- **Canvas Parameters**: Canvas dimensions and background settings

### Outputs
- **Composite Image**: Single image with positioned elements on canvas
- **Fixed Canvas Size**: Canvas dimensions as configured
- **Format Options**: Raw image object or encoded file formats

## Configuration Options

### Input/Output Paths
- **Input From**: `msg.payload` (default), `flow.*`, `global.*`
- **Output To**: `msg.payload` (default), `flow.*`, `global.*`

### Canvas Configuration

#### Canvas Dimensions
- **Canvas Width**: Width of output canvas in pixels
- **Canvas Height**: Height of output canvas in pixels
- **Sources**: Number, `msg.*`, `flow.*`, `global.*`

#### Background Settings
- **Background Color**: Color for empty canvas areas
- **Default**: Black (`#000000`)
- **Formats**: Hex (`#FF0000`), RGB (`rgb(255,0,0)`), named colors

### Positioning System

#### Coordinate System
- **Normalized Coordinates**: Toggle between 0-1 range and pixel coordinates
- **Normalized Mode**: Values from 0.0 to 1.0 (relative to canvas dimensions)
- **Pixel Mode**: Absolute pixel coordinates

#### Position Configuration
- **Position Mappings**: Array of position configurations in node editor
- **Array Index**: Which image from input array to position
- **X/Y Coordinates**: Position on canvas (normalized or pixel)
- **Per-Image Control**: Individual positioning for each image

### Output Format Options
- **Raw**: Standard image object (fastest for processing chains)
- **JPEG**: Compressed with quality control
- **PNG**: Lossless with transparency support
- **WebP**: Modern format with excellent compression

## Performance Notes

### C++ Backend Processing
- **Optimized Canvas Composition**: Efficient positioning and placement on fixed canvas
- **Memory Management**: Pre-allocated canvas with optimal memory usage
- **Batch Placement**: All images positioned in single C++ operation
- **Coordinate Validation**: Automatic bounds checking and position validation

### Position Processing
- **Coordinate Transformation**: Efficient conversion between normalized and pixel coordinates
- **Bounds Checking**: Automatic validation of positions within canvas boundaries  
- **Layer Management**: Proper handling of image placement order and overlaps

## Real-World Examples

### Custom Dashboard Layout
```javascript
// In function node: set specific positions for dashboard elements
msg.positions = [
  { arrayIndex: 0, x: 0, y: 0 },      // Chart at top-left
  { arrayIndex: 1, x: 400, y: 0 },    // KPI at top-right
  { arrayIndex: 2, x: 0, y: 300 },    // Graph at bottom-left  
  { arrayIndex: 3, x: 400, y: 300 }   // Table at bottom-right
];
```
```
[Dashboard Elements] → [Function: Set Positions] → [Mosaic: 800x600 canvas] → [Dashboard]
```

### Template-Based Layout
```javascript
// Predefined layout template positions
msg.positions = [
  { arrayIndex: 0, x: 0.1, y: 0.1 },    // Normalized coordinates
  { arrayIndex: 1, x: 0.6, y: 0.1 },    // 10% and 60% from left
  { arrayIndex: 2, x: 0.1, y: 0.6 }     // 10% and 60% from top
];
```
```
[Content Images] → [Function: Apply Template] → [Mosaic: Normalized coords] → [Layout]
```

### Overlay Composition
```
[Base Image] → [Array-In: pos=0] ┐
[Logo Overlay] → [Array-In: pos=1] ├→ [Function: Set Positions] → [Mosaic: Canvas] → [Branded Image]
[Text Overlay] → [Array-In: pos=2] ┘
```
Position logos and text overlays at specific coordinates.

### Print Layout Design
```javascript
// Precise positioning for print layout
msg.canvasWidth = 1200;  // Print width
msg.canvasHeight = 1800; // Print height
msg.positions = [
  { arrayIndex: 0, x: 100, y: 100 },   // Header image
  { arrayIndex: 1, x: 100, y: 400 },   // Content image
  { arrayIndex: 2, x: 100, y: 1200 }   // Footer image
];
```

## Common Issues & Troubleshooting

### Position Configuration Errors
- **Issue**: Images not appearing or positioned incorrectly
- **Solution**: Verify arrayIndex values match input array length
- **Validation**: Check that positions array contains valid coordinates

### Coordinate System Confusion  
- **Issue**: Images appearing in wrong locations
- **Solution**: Verify normalized vs. pixel coordinate mode matches your values
- **Normalized**: Use 0-1 values for relative positioning
- **Pixel**: Use absolute coordinates within canvas bounds

### Canvas Size Problems
- **Issue**: Images clipped or positioned outside visible area
- **Solution**: Ensure canvas dimensions accommodate all positioned images
- **Planning**: Calculate required canvas size based on image positions and sizes

### Position Array Mismatches
- **Issue**: ArrayIndex references non-existent images
- **Result**: Images ignored with warnings logged
- **Solution**: Validate arrayIndex values against input array length

## Integration Patterns

### Gallery Creation Workflow
```
Image Collection → Resize (thumbnails) → Mosaic → Gallery Display → Save
```
Standard photo gallery creation pipeline.

### Product Catalog Generation
```
Product Photos → Crop (consistent) → Mosaic (catalog layout) → Print/Web Output
```
Automated product catalog page generation.

### Report Dashboard
```
Multiple Data Sources → Generate Charts → Collect Images → Mosaic → Dashboard Page
```
Automated dashboard generation from multiple data sources.

### Social Media Automation
```
User Photos → Filter (best) → Resize (square) → Mosaic → Social Platform Upload
```
Automated social media collage creation.

## Advanced Usage

### Dynamic Grid Sizing
```javascript
// In a function node before mosaic:
const imageCount = msg.images.length;
const columns = Math.ceil(Math.sqrt(imageCount));
const rows = Math.ceil(imageCount / columns);

msg.gridColumns = columns;
msg.gridRows = rows;
```

### Responsive Layout Logic
```javascript
// Adapt grid based on image count
if (msg.images.length <= 4) {
  msg.gridColumns = 2;
} else if (msg.images.length <= 9) {
  msg.gridColumns = 3;
} else if (msg.images.length <= 16) {
  msg.gridColumns = 4;
} else {
  msg.gridColumns = Math.ceil(Math.sqrt(msg.images.length));
}
```

### Smart Cell Sizing
```javascript
// Calculate cell size based on target output dimensions
const targetWidth = 1200;
const targetHeight = 800;
const margins = 40;
const gaps = 10;

const availableWidth = targetWidth - (2 * margins) - ((msg.gridColumns - 1) * gaps);
const availableHeight = targetHeight - (2 * margins) - ((msg.gridRows - 1) * gaps);

msg.cellWidth = Math.floor(availableWidth / msg.gridColumns);
msg.cellHeight = Math.floor(availableHeight / msg.gridRows);
```

### Conditional Formatting
```javascript
// Different layout for different content types
if (msg.contentType === 'photos') {
  msg.backgroundColor = '#FFFFFF';
  msg.gapSize = 5;
} else if (msg.contentType === 'products') {
  msg.backgroundColor = '#F5F5F5';
  msg.gapSize = 15;
} else if (msg.contentType === 'charts') {
  msg.backgroundColor = '#FAFAFA';
  msg.gapSize = 20;
}
```

## Best Practices

### Image Preparation
- Resize images to appropriate dimensions before mosaic creation
- Ensure consistent aspect ratios for uniform appearance
- Apply consistent color correction across image set

### Grid Planning
- Consider final output dimensions when planning grid size
- Use square grids for social media, rectangular for print/web
- Plan for appropriate margins and gaps for visual breathing room

### Memory Management  
- Use appropriately sized images for final display requirements
- Avoid creating unnecessarily large mosaics
- Monitor memory usage with large image collections

### Quality Optimization
- Use high-quality source images for best scaling results
- Choose appropriate output format for final destination
- Consider compression settings for web vs. print use

### Layout Design
- Plan grid dimensions based on image count and content type
- Use consistent spacing for professional appearance
- Consider viewing context (mobile, desktop, print) when sizing

### Performance Considerations
- Process reasonable numbers of images to maintain responsiveness
- Use raw format for processing chains
- Pre-calculate dimensions to optimize memory allocation

## Format-Specific Considerations

### For Web Galleries
- Use JPEG with appropriate compression for photos
- Consider PNG for graphics or when transparency needed
- Optimize file size for fast loading

### For Print Layouts
- Use PNG for highest quality preservation
- Ensure sufficient resolution for print requirements
- Consider bleed areas and print margins

### For Social Media
- Plan dimensions for specific platform requirements (Instagram: 1:1, Facebook: 16:9)
- Use appropriate compression for platform upload limits
- Consider mobile viewing experience and legibility