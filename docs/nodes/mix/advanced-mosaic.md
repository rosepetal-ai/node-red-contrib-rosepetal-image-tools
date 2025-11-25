# Advanced Mosaic Node

## Purpose & Use Cases

The `advanced-mosaic` node provides sophisticated layout capabilities beyond basic grids, supporting custom positioning, variable cell sizes, and complex arrangement patterns. It enables pixel-perfect control over image placement for professional layouts and artistic compositions.

**Real-World Applications:**
- **Magazine Layouts**: Create complex editorial layouts with varying image sizes
- **Web Design Mockups**: Arrange elements in custom positions for design prototypes
- **Artistic Compositions**: Create asymmetric, visually interesting image arrangements
- **Dashboard Design**: Position charts and data visualizations with precise control
- **Poster Creation**: Design promotional materials with sophisticated image arrangements

*[PLACEHOLDER - Add GIF showing complex layouts with custom positioning and variable cell sizes]*

## Input/Output Specification

### Inputs
- **Image Array**: Array of image objects with optional position metadata
- **Layout Configuration**: Custom positioning data via message properties or configuration
- **Canvas Parameters**: Target canvas dimensions and layout constraints

### Outputs
- **Complex Layout**: Single composite image with precisely positioned elements
- **Custom Canvas**: Canvas sized according to layout requirements or fixed dimensions
- **Format Options**: Raw image object or encoded file formats
- **Mask Propagation (optional)**: When enabled, a second output array containing masks transformed with the exact same resize/rotate/position steps. Each mask index aligns with the source image index and is ready for downstream drawing/overlay nodes.

## Configuration Options

### Input/Output Paths
- **Input From**: `msg.payload` (default), `flow.*`, `global.*`
- **Output To**: `msg.payload` (default), `flow.*`, `global.*`

### Canvas Configuration

#### Canvas Size
- **Fixed Dimensions**: Specify exact width and height
- **Auto Size**: Calculate canvas size based on image positions and sizes
- **Aspect Ratio**: Maintain specific aspect ratio while auto-sizing

#### Background Settings
- **Background Color**: Color for empty canvas areas
- **Background Image**: Use image as background behind positioned elements
- **Transparency**: Support for transparent backgrounds (PNG output)

### Positioning System

#### Position Modes
- **Absolute**: X,Y coordinates in pixels
- **Relative**: Positions as percentages of canvas size (0-1)
- **Grid-Based**: Enhanced grid system with custom cell sizes
- **Flow Layout**: Automatic positioning with spacing rules

#### Position Sources
- **Configuration**: Set positions in node editor
- **Message Data**: Position data provided per image in input array
- **Dynamic Calculation**: Calculate positions using function nodes

### Advanced Layout Features

#### Variable Cell Sizes
- **Custom Width/Height**: Each image can have different cell dimensions
- **Aspect Ratio Preservation**: Maintain image proportions within custom cells
- **Scaling Options**: Fit, fill, or stretch images within designated areas

#### Layering and Z-Order
- **Layer Control**: Specify which images appear above others
- **Overlap Handling**: Manage overlapping elements gracefully
- **Transparency Support**: Proper alpha blending for overlapping areas

### Output Format Options
- **Raw**: Standard image object (fastest for processing chains)
- **JPEG**: Compressed (transparency becomes background color)
- **PNG**: Full transparency and quality preservation
- **WebP**: Modern format with transparency and compression
- **Mask Propagation**: Enable the *Propagate masks* checkbox to feed a mask array (one per input image index). The node applies the same resize/rotate/position to each mask and emits a transformed mask array for downstream overlay/drawing without manual conversions.

## Mask Propagation Input Format

When *Propagate masks* is enabled, supply `msg.masks` (or the configured path) as an **array aligned to the input images array**. Index `i` is the mask for image `i`. Each entry can be one of:

- **Polygon mask**: `{ tag?: "class", polygons: [ [ [x,y], [x,y], ... ] , ... ] }` where points are normalized 0–1.
- **Raw mask image**: `{ mask: { data, width, height, channels, colorSpace, dtype } , tag?: "class" }` (RGBA/LA/GRAY accepted; alpha preferred).
- **2D matrix mask**: `{ mask: [[0,1,1,...], ...], tag?: "class" }` or simply a 2D/array-of-2D numeric matrix.

Rules:
- Array length should match the images array; missing entries are ignored.
- `tag`/`class`/`class_name`/`label` are passed through if present.
- Masks are binarized, resized with `INTER_NEAREST`, rotated, and positioned exactly like their source image. The output `masks` array mirrors the input order and is ready for downstream drawing nodes.

## Performance Notes

### C++ Backend Processing
- **Optimized Rendering**: Efficient composite rendering with layer management
- **Memory Management**: Smart memory allocation for complex layouts
- **Overlap Detection**: Optimized algorithms for handling overlapping elements
- **High-Quality Scaling**: Professional-grade scaling for variable-sized elements

### Layout Engine
- **Position Validation**: Automatic bounds checking and constraint handling
- **Layer Ordering**: Efficient z-order processing for overlapping elements
- **Canvas Optimization**: Minimal canvas size calculation for auto-sizing modes

## Real-World Examples

### Magazine Article Layout
```javascript\n// In function node: set custom positions for magazine layout\nmsg.images.forEach((img, i) => {\n  if (i === 0) { // Hero image\n    img.position = { x: 0, y: 0, width: 800, height: 400 };\n  } else if (i === 1) { // Side image\n    img.position = { x: 820, y: 0, width: 300, height: 200 };\n  } else { // Thumbnail strip\n    img.position = { x: 100 * i, y: 420, width: 80, height: 80 };\n  }\n});\n```\nCreate professional magazine-style layouts with hero images and supporting visuals.\n\n### Dashboard Layout\n```\n[Chart Images] → [Function: Set Positions] → [Advanced Mosaic: Custom layout] → [Dashboard]\n```\nPosition charts, graphs, and KPI displays in precise dashboard arrangements.\n\n### Product Showcase\n```javascript\n// Custom product display with hero and detail shots\nmsg.productImages[0].position = { x: 0, y: 0, width: 600, height: 600 }; // Main product\nmsg.productImages[1].position = { x: 620, y: 0, width: 280, height: 200 }; // Detail 1\nmsg.productImages[2].position = { x: 620, y: 220, width: 280, height: 200 }; // Detail 2\nmsg.productImages[3].position = { x: 620, y: 440, width: 280, height: 160 }; // Detail 3\n```\n\n### Artistic Collage Creation\n```\n[Art Images] → [Function: Random Positions] → [Advanced Mosaic: Overlap enabled] → [Artistic Collage]\n```\nCreate visually interesting overlapping compositions with controlled randomness.\n\n### Web Design Mockup\n```\n[UI Elements] → [Function: Responsive Positions] → [Advanced Mosaic: Fixed canvas] → [Mockup]\n```\nArrange UI elements for web design prototypes and mockups.\n\n## Common Issues & Troubleshooting\n\n### Position Conflicts\n- **Issue**: Images overlapping unintentionally or awkward positioning\n- **Solution**: Validate position calculations and implement collision detection\n- **Prevention**: Use position validation functions before processing\n\n### Canvas Size Problems\n- **Issue**: Canvas too small for positioned elements or excessive whitespace\n- **Solution**: Use auto-sizing or carefully calculate required canvas dimensions\n- **Planning**: Consider element positions and sizes when planning canvas\n\n### Performance with Complex Layouts\n- **Issue**: Slow processing with many overlapping elements\n- **Optimization**: Minimize unnecessary overlaps, use appropriate image sizes\n- **Monitoring**: Track processing times and optimize layout complexity\n\n### Memory Issues\n- **Issue**: Large canvases with high-resolution images consume excessive memory\n- **Solution**: Use appropriately sized images for final output requirements\n- **Strategy**: Consider final display size when sizing source images\n\n## Integration Patterns\n\n### Professional Layout Workflow\n```\nContent → Analyze Layout → Calculate Positions → Advanced Mosaic → Output\n```\nAutomated professional layout generation based on content analysis.\n\n### Interactive Design System\n```\nUser Input → Position Calculator → Advanced Mosaic → Preview → Iterate\n```\nInteractive layout system for design applications.\n\n### Template-Based Generation\n```\nLayout Template → Apply to Content → Advanced Mosaic → Branded Output\n```\nUse predefined templates for consistent branded layouts.\n\n### Responsive Layout System\n```\nContent → Detect Screen Size → Calculate Responsive Positions → Advanced Mosaic → Adaptive Output\n```\nCreate layouts that adapt to different output dimensions.\n\n## Advanced Usage\n\n### Template-Based Positioning\n```javascript\n// Define layout templates\nconst templates = {\n  hero: {\n    main: { x: 0, y: 0, width: 0.7, height: 1.0 },\n    sidebar: [  \n      { x: 0.72, y: 0, width: 0.28, height: 0.3 },\n      { x: 0.72, y: 0.32, width: 0.28, height: 0.3 },\n      { x: 0.72, y: 0.64, width: 0.28, height: 0.36 }\n    ]\n  },\n  grid: {\n    // Define grid-based template\n  }\n};\n\nmsg.layout = templates[msg.layoutType];\n```\n\n### Responsive Position Calculation\n```javascript\n// Calculate positions based on canvas size\nfunction calculateResponsivePositions(images, canvasWidth, canvasHeight) {\n  return images.map((img, i) => {\n    // Implement responsive positioning logic\n    const position = {\n      x: Math.floor((i % 3) * canvasWidth / 3),\n      y: Math.floor(Math.floor(i / 3) * canvasHeight / 3),\n      width: canvasWidth / 3 - 10,\n      height: canvasHeight / 3 - 10\n    };\n    return { ...img, position };\n  });\n}\n```\n\n### Overlap Management\n```javascript\n// Detect and resolve position conflicts\nfunction resolveOverlaps(elements) {\n  for (let i = 0; i < elements.length; i++) {\n    for (let j = i + 1; j < elements.length; j++) {\n      if (elementsOverlap(elements[i], elements[j])) {\n        // Implement overlap resolution strategy\n        adjustPosition(elements[j], elements[i]);\n      }\n    }\n  }\n  return elements;\n}\n```\n\n### Dynamic Layout Optimization\n```javascript\n// Optimize layout based on content analysis\nfunction optimizeLayout(images, canvasSize) {\n  // Analyze image importance, size requirements, etc.\n  const important = images.filter(img => img.priority === 'high');\n  const secondary = images.filter(img => img.priority === 'medium');\n  const background = images.filter(img => img.priority === 'low');\n  \n  // Position important images first, then fill with secondary\n  return arrangeByPriority(important, secondary, background, canvasSize);\n}\n```\n\n## Best Practices\n\n### Layout Design\n- Plan layouts on paper or design tools before implementing\n- Use consistent spacing and alignment principles\n- Consider visual hierarchy and reading patterns\n- Test layouts with different content variations\n\n### Position Management\n- Use relative positioning for responsive layouts\n- Implement position validation to prevent errors\n- Consider overlap handling strategies from the start\n- Document position calculation logic for maintenance\n\n### Performance Optimization\n- Use appropriate image sizes for final output requirements\n- Minimize unnecessary overlapping elements\n- Consider memory implications of large canvas sizes\n- Profile performance with realistic content loads\n\n### Quality Considerations\n- Use high-quality source images for scaling operations\n- Choose appropriate output formats for intended use\n- Consider compression settings for web vs. print\n- Test final output in intended display environment\n\n### Development Workflow\n- Start with simple positioning and add complexity gradually\n- Use debug output to verify position calculations\n- Implement position validation and error handling\n- Create reusable positioning templates for consistency
