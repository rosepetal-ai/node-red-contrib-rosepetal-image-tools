# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and Development Commands

### Quick Setup
```bash
# Complete installation (installs system deps and builds C++ engine)
./install.sh
```

### Manual Build Process
```bash
# Build C++ engine only
cd rosepetal-image-engine
npm run build          # Standard build
npm run rebuild         # Clean rebuild
npm run configure       # Configure only

# Install Node-RED package
cd node-red-contrib-rosepetal-image-tools
npm install

# Install into Node-RED instance
cd ~/.node-red
npm install /path/to/node-red-contrib-rosepetal-image-tools
```

### System Requirements
- Node.js 16+ with node-gyp support
- OpenCV 4.x (auto-detected via pkg-config)
- C++ compiler with C++17 support
- Platform support: Linux (Debian/Ubuntu, Fedora/CentOS, Arch), macOS

## Architecture Overview

### Two-Tier Hybrid Structure
This is a **hybrid JavaScript/C++ Node-RED package** with performance-critical operations implemented in C++:

- **JavaScript Layer**: Node-RED nodes (`nodes/`) handle UI, configuration, validation, and I/O routing
- **C++ Layer**: High-performance OpenCV-based image processing (`rosepetal-image-engine/src/`)
- **Bridge Layer**: `lib/cpp-bridge.js` provides promisified access to C++ addon functions
- **Utilities**: `lib/node-utils.js` contains shared validation, conversion, and error handling

### Image Data Format
The system uses a **standardized image object format**:

```javascript
{
  data: Buffer,        // Raw pixel data
  width: number,       // Image width in pixels  
  height: number,      // Image height in pixels
  channels: number,    // Channel count (1, 3, 4)
  colorSpace: string,  // "GRAY", "RGB", "RGBA", "BGR", "BGRA"
  dtype: string        // "uint8", "uint16", "float32"
}
```

### Node Categories and Data Flow

**I/O Nodes** (`nodes/io/`): Data flow management
- `image-in`: Filesystem loading with Sharp decoding
- `array-in`: Collect data into positioned arrays  
- `array-out`: Assemble arrays from multiple sources
- `array-select`: Extract elements with flexible selection

**Transform Nodes** (`nodes/transform/`): Single image processing
- `resize`, `rotate`, `crop`, `padding`, `filter`: Core OpenCV operations

**Mix Nodes** (`nodes/mix/`): Multi-image composition  
- `concat`: Horizontal/vertical combination
- `mosaic`: Grid layouts with positioning

## Development Patterns

### Adding New Image Processing Nodes

1. **C++ Implementation** (`rosepetal-image-engine/src/`):
   ```cpp
   // Create new_operation.cpp
   #include <opencv2/opencv.hpp>
   #include <napi.h>
   
   Napi::Value NewOperation(const Napi::CallbackInfo& info) {
     // Implement OpenCV operation
   }
   ```

2. **Export in main.cpp**:
   ```cpp
   exports.Set(Napi::String::New(env, "newOperation"), 
               Napi::Function::New(env, NewOperation));
   ```

3. **Add to binding.gyp sources**:
   ```json
   "sources": ["src/main.cpp", "src/new_operation.cpp", ...]
   ```

4. **Create Node-RED wrapper** (`nodes/category/new-operation.js`):
   ```javascript
   const cppBridge = require('../../lib/cpp-bridge');
   const utils = require('../../lib/node-utils')(RED);
   
   module.exports = function(RED) {
     function NewOperationNode(config) {
       // Use utils.validateImageStructure()
       // Call cppBridge.newOperation()
       // Apply utils.handleNodeError() and utils.setSuccessStatus()
     }
     RED.nodes.registerType("new-operation", NewOperationNode);
   }
   ```

5. **Register in package.json**:
   ```json
   "node-red": {
     "nodes": {
       "new-operation": "nodes/category/new-operation.js"
     }
   }
   ```

### Image Validation and Error Handling

**Always use standardized utilities**:
```javascript
const utils = require('../../lib/node-utils')(RED);

// Validate single image
const normalized = utils.validateImageStructure(image, node);
if (!normalized) return; // Warning already sent

// Validate image arrays  
if (!utils.validateListImage(imageList, node)) return;

// Handle errors consistently
utils.handleNodeError(node, error, msg, done, 'operation_name');

// Set success status with timing
utils.setSuccessStatus(node, count, totalTime, { convertMs, taskMs, encodeMs });
```

### C++ Addon Integration

**Key Integration Points**:
- All C++ functions are **automatically promisified** by `cpp-bridge.js`
- Use **OpenCV Mat objects** for image processing
- Apply **performance optimizations**: `-O3`, `-march=native`, `-ffast-math`
- Handle **multiple color spaces**: RGB, BGR, RGBA, BGRA, GRAY
- Support **parallel processing** for image arrays

**OpenCV Build Configuration**:
```json
// binding.gyp optimization flags
"cflags_cc": ["-std=c++17", "-O3", "-ffast-math", "-march=native", "-funroll-loops"]
```

## Common Development Tasks

### Testing Image Operations
```bash
# Test C++ engine directly  
cd rosepetal-image-engine
node test-formats.js

# Test Node-RED integration
# Use Node-RED debug nodes with test images
```

### Performance Optimization
- **C++ Backend**: 10-100x faster than pure JavaScript
- **Memory Management**: Efficient OpenCV Mat handling
- **Parallel Processing**: Array inputs processed concurrently
- **Timing Display**: Processing time shown in node status

### Output Format Handling
- **Raw Format**: Fastest for processing chains (no encoding overhead)
- **JPEG/PNG/WebP**: Encoded formats for final output or storage
- **Format Conversion**: Use `utils.rawToJpeg()` for standardized conversion

## Troubleshooting

### Build Issues
- **OpenCV Not Found**: Ensure `pkg-config --exists opencv4` succeeds
- **Node-gyp Failures**: Check Node.js version (16+) and build tools
- **Missing Dependencies**: Run system package installation via `install.sh`

### Runtime Issues  
- **Invalid Image Structure**: Check `utils.validateImageStructure()` warnings
- **Memory Issues**: Process large images in smaller batches
- **Performance Problems**: Verify C++ addon built with optimization flags

### Debug Information
- **Node Status**: Real-time processing timing and status
- **Validation Warnings**: Comprehensive input validation messages
- **Error Context**: Standardized error reporting with operation context

## Image Processing Workflows

### Typical Processing Chain
```
image-in → transform nodes → [array processing] → mix nodes → output
```

### Batch Processing Pattern  
```
[multiple image-in] → [array-in nodes] → array-out → transform → array-select
```

### Format Considerations
- Use **raw format** for intermediate processing steps (fastest)  
- Use **encoded formats** (JPEG/PNG/WebP) for final outputs