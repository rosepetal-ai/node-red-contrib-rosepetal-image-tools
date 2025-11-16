# CropBB Node (Crop Bounding Boxes)

## Purpose & Use Cases

The `cropBB` node is specialized for AI/ML workflows, extracting image crops from object detection bounding box results. It processes detection data and extracts individual objects or regions of interest from images, making it essential for computer vision pipelines.

**Real-World Applications:**
- **Object Detection Workflows**: Extract detected objects from AI analysis results
- **Quality Control Systems**: Crop defective areas identified by inspection AI
- **Security/Surveillance**: Extract detected persons or objects from camera feeds  
- **Medical Imaging**: Extract abnormalities or regions of interest from diagnostic scans
- **E-commerce Automation**: Extract product images from catalog photos using AI detection

*[PLACEHOLDER - Add GIF showing AI detection results being converted to individual cropped objects]*

## Input/Output Specification

### Inputs
- **Images**: Single image or array of images to crop from
- **Detection Data**: Bounding box detection results from AI/ML inference
- **Confidence Filtering**: Minimum confidence threshold for including detections

### Detection Data Format
The node expects detection results in this format:
```javascript
[
  {
    "box": [[x1,y1], [x2,y1], [x2,y2], [x1,y2]], // Normalized 0-1 coordinates
    "confidence": 0.97,
    "class_name": "person", 
    "class_tag": 3
  },
  // ... more detections
]
```

### Outputs
```javascript
[
  {
    crop: ImageObject,     // Cropped image
    tag: {
      label: "person",     // Detection class name
      confidence: 0.97,    // Detection confidence
      bbox: {              // Bounding box information
        x: 150, y: 100,    // Pixel coordinates
        width: 200, height: 300,
        normalized: { x1: 0.1, y1: 0.2, x2: 0.3, y2: 0.5 }
      }
    }
  },
  // ... more crops
]
```

## Configuration Options

### Input Paths
- **Image Input Path**: Location of source images (default: `msg.images`)
- **Bounding Box Input Path**: Location of detection data (default: `msg.default`)
- **Path Sources**: `msg.*`, `flow.*`, `global.*`

### Output Configuration
- **Output Path**: Where to store crop results (default: `msg.payload`)
- **Output Format**: Raw, JPEG, PNG, or WebP
- **Quality Settings**: Compression settings for encoded formats

### Detection Filtering

#### Minimum Confidence
- **Range**: 0.0 to 1.0 (0% to 100%)
- **Default**: 0.5 (50% confidence)
- **Purpose**: Filter out low-confidence detections
- **Sources**: Number, `msg.*`, `flow.*`, `global.*`

#### Class Filtering
- **Specific Classes**: Only crop detections of specified classes
- **Class Names**: Filter by class_name field (e.g., "person", "car")
- **Class Tags**: Filter by numeric class_tag field

### Processing Options

#### Coordinate Handling
- **Normalized Input**: Handles 0-1 coordinate format (standard)
- **Pixel Conversion**: Automatically converts to pixel coordinates
- **Bounds Clipping**: Ensures crops stay within image boundaries
- **Validation**: Checks for valid box formats and dimensions

#### Output Format Options
- **Raw**: Standard image objects (fastest for processing chains)
- **JPEG**: Compressed crops with quality control
- **PNG**: Lossless crops preserving quality
- **WebP**: Modern format with excellent compression

## Performance Notes

### C++ Backend Processing
- **Parallel Cropping**: Multiple crops extracted simultaneously
- **Memory Efficient**: Direct region extraction without full image copying
- **Bounds Checking**: Automatic coordinate validation and clipping
- **Batch Processing**: Optimized for multiple detections per image

### Detection Processing
- **Format Validation**: Robust parsing of various detection formats
- **Coordinate Conversion**: Efficient normalized-to-pixel coordinate conversion
- **Confidence Filtering**: Fast threshold-based filtering before cropping
- **Error Handling**: Graceful handling of malformed detection data

## Real-World Examples

### Object Detection Pipeline
```
[Image] → [AI Detection Model] → [CropBB: confidence=0.7] → [Individual Objects]
```
Extract all detected objects with 70%+ confidence from AI analysis.

### Quality Control System
```
[Product Image] → [Defect Detection AI] → [CropBB: class="defect"] → [Defect Crops] → [Analysis]
```
Extract defective areas for detailed quality analysis.

### Security Surveillance
```
[Camera Feed] → [Person Detection] → [CropBB: class="person", confidence=0.8] → [Person Crops] → [Recognition]
```
Extract detected persons for facial recognition processing.

### Medical Imaging Analysis
```
[Medical Scan] → [Anomaly Detection] → [CropBB: confidence=0.9] → [Suspicious Regions] → [Specialist Review]
```
Extract high-confidence anomalies for medical specialist review.

### E-commerce Automation
```
[Catalog Photo] → [Product Detection] → [CropBB: class="product"] → [Product Crops] → [Individual Listings]
```
Automatically extract individual products from multi-product photos.

## Common Issues & Troubleshooting

### No Crops Generated
- **Issue**: Node outputs empty array despite detection data
- **Causes**: Confidence threshold too high, incorrect data format, missing detection data
- **Solution**: Lower confidence threshold, verify detection format, check input paths

### Malformed Detection Data
- **Issue**: Node warns about invalid box format
- **Cause**: Detection data doesn't match expected 4-corner format
- **Solution**: Verify AI model output format, transform data if needed

### Poor Crop Quality
- **Issue**: Crops appear pixelated or low quality
- **Cause**: Source image resolution too low for detection boxes
- **Solution**: Use higher resolution source images or adjust detection model

### Coordinate Issues
- **Issue**: Crops appear in wrong locations or are empty
- **Cause**: Coordinate system mismatch between detection model and expectations
- **Solution**: Verify detection model uses normalized 0-1 coordinates

### Memory Usage
- **Issue**: High memory usage with many detections
- **Optimization**: Process images in smaller batches, use appropriate output formats
- **Monitoring**: Monitor crop count and source image sizes

## Integration Patterns

### Computer Vision Pipeline
```
Image → AI Detection → CropBB → Individual Analysis → Results Aggregation
```
Standard computer vision workflow for object analysis.

### Quality Inspection System
```
Product → Defect Detection → CropBB → Defect Classification → Pass/Fail Decision
```
Automated quality control with defect analysis.

### Surveillance Processing
```
Video Frame → Object Detection → CropBB → Tracking/Recognition → Alert System
```
Security surveillance with object tracking.

### Medical Analysis Workflow
```
Medical Image → AI Analysis → CropBB → Specialist Review → Diagnosis Support
```
Medical imaging analysis with region extraction.

## Advanced Usage

### Dynamic Confidence Adjustment
```javascript
// In function node before cropBB:
// Adjust confidence based on detection class
msg.detections.forEach(det => {
  if (det.class_name === 'person') {
    det.useConfidence = 0.8; // High confidence for people
  } else if (det.class_name === 'vehicle') {
    det.useConfidence = 0.6; // Medium confidence for vehicles
  } else {
    det.useConfidence = 0.5; // Default confidence
  }
});
```

### Detection Filtering and Sorting
```javascript
// Filter and sort detections before cropping
msg.detections = msg.detections
  .filter(det => det.confidence > 0.7)
  .filter(det => ['person', 'car', 'truck'].includes(det.class_name))
  .sort((a, b) => b.confidence - a.confidence); // Sort by confidence descending
```

### Crop Size Validation
```javascript
// Filter out crops that would be too small
msg.detections = msg.detections.filter(det => {
  const box = det.box;
  const width = (box[2][0] - box[0][0]) * msg.image.width;
  const height = (box[2][1] - box[0][1]) * msg.image.height;
  return width > 50 && height > 50; // Minimum 50x50 pixels
});
```

### Multi-Class Processing
```javascript
// Process different classes with different settings
const personDetections = msg.detections.filter(d => d.class_name === 'person');
const vehicleDetections = msg.detections.filter(d => d.class_name === 'vehicle');

msg.personCropSettings = { confidence: 0.8, outputFormat: 'png' };
msg.vehicleCropSettings = { confidence: 0.6, outputFormat: 'jpg' };
```

## Best Practices

### Detection Data Quality
- Ensure AI models output consistent coordinate formats
- Validate detection data before processing
- Handle edge cases (empty detections, malformed data)
- Monitor detection confidence distributions

### Performance Optimization
- Use appropriate confidence thresholds to reduce processing load
- Process images at appropriate resolutions for your detection models
- Use raw format for processing chains, encoded formats for final output
- Consider batch processing for large image sets

### Quality Control
- Implement validation checks for crop dimensions
- Monitor crop quality and adjust source image resolution if needed
- Set appropriate confidence thresholds for your use case
- Test with representative data sets

### Error Handling
- Implement fallback behavior for missing detection data
- Handle coordinate validation errors gracefully
- Log processing statistics for monitoring and optimization
- Provide meaningful error messages for debugging

### Integration Strategy
- Design detection data format standards for your pipeline
- Implement confidence threshold tuning based on performance metrics
- Consider storage and processing requirements for crop outputs
- Plan for scalability with large detection volumes
