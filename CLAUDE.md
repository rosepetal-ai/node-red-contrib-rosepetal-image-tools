# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Node-RED image processing toolkit consisting of two main components:
1. **node-red-contrib-rosepetal-image-tools**: Node-RED package with image processing nodes
2. **rosepetal-image-engine**: C++ addon built with OpenCV for high-performance image operations

The project provides Node-RED nodes for image processing operations like resize, rotate, crop, concat, padding, filtering, and mosaic creation.

## Build and Installation Commands

### Initial Setup (from project root)
```bash
# Install system dependencies and build everything
./install.sh

# Manual installation steps:
cd rosepetal-image-engine
npm install
npm run build

cd ../node-red-contrib-rosepetal-image-tools
npm install
```

### C++ Engine Build Commands (in rosepetal-image-engine/)
```bash
npm run build       # Build the C++ addon
npm run configure   # Configure node-gyp
npm run rebuild     # Clean rebuild
```

### Node-RED Integration
```bash
# Install in Node-RED (from .node-red directory)
cd ~/.node-red
npm install /path/to/node-red-contrib-rosepetal-image-tools
```

## Architecture

### Two-Tier Structure
- **JavaScript Layer**: Node-RED nodes handle configuration, validation, and I/O
- **C++ Layer**: High-performance OpenCV-based image processing via Node.js addon

### Node-RED Node Structure
Each node consists of:
- `*.js` file: Node logic using `lib/node-utils.js` and `lib/cpp-bridge.js`
- `*.html` file: UI configuration with TypedInput widgets for dynamic property sources

### Node Categories
- **I/O nodes** (`nodes/io/`): `image-in`, `array-in`, `array-out`, `array-select`
- **Transform nodes** (`nodes/transform/`): `resize`, `rotate`, `crop`, `padding`, `filter`
- **Mix nodes** (`nodes/mix/`): `concat`, `mosaic`

### Key Libraries
- **lib/cpp-bridge.js**: Promisified interface to C++ addon functions
- **lib/node-utils.js**: Common utilities for validation, dimension resolution, and error handling
- **Sharp**: Used only for JPEG conversion, not for image processing
- **OpenCV**: C++ backend for all image processing operations and format detection

### Image Data Format
Images are passed as objects using the new structure:
```javascript
{
  data: Buffer,        // Raw pixel data or file buffer
  width: number,       // Image width in pixels
  height: number,      // Image height in pixels
  channels: number,    // Channel count (1, 3, 4)
  colorSpace: string,  // "GRAY", "RGB", "RGBA", "BGR", "BGRA"
  dtype: string        // "uint8", "uint16", "float32"
}
```

**Legacy Format Support**: The system maintains backward compatibility with the old format:
```javascript
{
  data: Buffer,
  width: number,
  height: number,
  channels: string     // e.g., "int8_RGB", "int8_RGBA", "int8_GRAY"
}
```

### Configuration System
- Nodes support dynamic property sources via TypedInput: `msg`, `flow`, `global`, `num`
- Input/output paths are configurable for flexible data routing
- Many nodes support both single images and arrays transparently

### C++ Addon Structure
- Built with N-API (node-addon-api)
- Optimized build flags: `-O3`, `-march=native`, `-ffast-math`
- All functions are async and promisified in JavaScript layer
- Uses OpenCV 4.x with pkg-config detection

## Development Notes

### Performance Considerations
- C++ operations include timing information in results
- Nodes display performance metrics in status
- Image arrays are processed in parallel using Promise.all()

### Error Handling & Validation
- **New Validation System**: `NodeUtils.validateImageStructure()` with comprehensive input validation
- **Warning-Based Approach**: Uses `node.warn()` instead of throwing exceptions
- **No Message Propagation**: Invalid inputs are blocked from proceeding through the flow
- **Backward Compatibility**: Supports both new and legacy image formats
- **Automatic Inference**: Missing fields like `channels`, `colorSpace`, `dtype` are inferred when possible

### Input Format Support
- **File Buffers**: JPEG, PNG, WebP, BMP files are automatically detected and decoded by C++
- **Raw Image Data**: Pixel data with explicit dimensions and format information
- **Mixed Inputs**: Nodes can handle both encoded files and raw pixel data transparently

### Adding New Nodes
1. Create C++ implementation in `rosepetal-image-engine/src/`
2. Export function in `src/main.cpp`
3. Add to `binding.gyp` sources
4. Create Node-RED wrapper in `nodes/`
5. Register in `package.json` node-red section