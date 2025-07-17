# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Node-RED contribution package that provides C++ powered image processing nodes using OpenCV. The project consists of two main parts:

1. **node-red-contrib-rosepetal-image-tools** - The Node-RED nodes package
2. **rosepetal-image-engine** - The C++ native addon for image processing

## Architecture

### Two-Part Structure
- **Node-RED Package** (`node-red-contrib-rosepetal-image-tools/`): Contains the Node-RED node definitions, HTML UI files, and JavaScript wrappers
- **C++ Engine** (`rosepetal-image-engine/`): Contains the native C++ addon built with N-API that interfaces with OpenCV

### Key Components

#### C++ Engine Architecture
- **Entry Point**: `src/main.cpp` - Exports functions to Node.js (resize, rotate, crop, concat, padding, filter)
- **OpenCV Integration**: Uses OpenCV 4 with optimized build flags for performance
- **Utilities**: `src/utils.h` - Provides image conversion utilities between Node.js and OpenCV Mat objects
- **Filter System**: `src/filters/` - Modular kernel-based image filtering with `kernels.h` for optimized kernel definitions
- **Build System**: Uses node-gyp with binding.gyp for native compilation

#### Node-RED Package Architecture
- **Bridge Layer**: `lib/cpp-bridge.js` - Promisifies the C++ addon functions
- **Node Utilities**: `lib/node-utils.js` - Common utilities for Node-RED nodes
- **Node Types**: 
  - IO: `nodes/io/image-in.js` - Image input using Sharp.js
  - Transform: `nodes/transform/` - resize, rotate, crop (x,y,width,height), padding, filter
  - Mix: `nodes/mix/concat.js` - Image concatenation

### Image Data Flow
1. Images enter via `image-in` node using Sharp.js, converted to raw format
2. Raw image objects contain: `{data: Buffer, width: number, height: number, channels: string}`
3. Channel format strings: `int8_GRAY`, `int8_RGB`, `int8_RGBA`, `int16_GRAY`, etc.
4. C++ functions process images using OpenCV Mat objects
5. Results can be output as raw objects or encoded as JPEG buffers

## Build Commands

### Initial Setup
```bash
# Install and build the C++ engine
cd node-red-contrib-rosepetal-image-tools
npm install  # This runs postinstall which builds the C++ addon
```

### Manual C++ Engine Build
```bash
cd rosepetal-image-engine
npm run build        # Builds the C++ addon
npm run configure    # Configures build environment
npm run rebuild      # Clean rebuild
```

### Dependencies
- OpenCV 4 must be installed system-wide (headers in `/usr/include/opencv4`)
- Node.js native build tools (node-gyp)
- C++17 compiler with OpenCV pkg-config support

## Development Notes

### Performance Optimization
- C++ build uses aggressive optimization flags: `-O3`, `-march=native`, `-funroll-loops`
- Image processing operations use OpenCV's optimized routines
- Memory management uses zero-copy transfers where possible

### Error Handling
- All Node-RED nodes use consistent error handling via `NodeUtils.handleNodeError()`
- C++ functions use N-API exception handling
- Status updates show timing information for performance monitoring

### Image Format Support
- Input: JPEG, PNG, WebP (via Sharp.js for image-in node)
- Internal: Raw RGB/RGBA/GRAY formats
- Output: Raw objects or JPEG-encoded buffers
- Color space handling: Automatic BGR/RGB conversion for OpenCV compatibility