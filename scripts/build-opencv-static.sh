#!/bin/bash
# Build minimal static OpenCV for pre-built binary distribution
# Usage: ./build-opencv-static.sh [BUILD_DIR] [INSTALL_DIR]
#
# This script builds OpenCV with only the modules needed by rosepetal-image-engine:
# - core, imgproc, imgcodecs
# - Bundled: libjpeg-turbo, libpng, libwebp, zlib

set -e

OPENCV_VERSION="${OPENCV_VERSION:-4.9.0}"
BUILD_DIR="${BUILD_DIR:-${1:-/tmp/opencv-build}}"
INSTALL_DIR="${INSTALL_DIR:-${2:-$HOME/opencv-static}}"
JOBS="${JOBS:-$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)}"

echo "=========================================="
echo "Building OpenCV ${OPENCV_VERSION} (static)"
echo "Build dir:   ${BUILD_DIR}"
echo "Install dir: ${INSTALL_DIR}"
echo "Parallel:    ${JOBS} jobs"
echo "=========================================="

# Create directories
mkdir -p "${BUILD_DIR}"
mkdir -p "${INSTALL_DIR}"

cd "${BUILD_DIR}"

# Download OpenCV if not present
if [ ! -d "opencv-${OPENCV_VERSION}" ]; then
    echo "Downloading OpenCV ${OPENCV_VERSION}..."
    curl -L -o opencv.zip "https://github.com/opencv/opencv/archive/refs/tags/${OPENCV_VERSION}.zip"
    unzip -q opencv.zip
    rm opencv.zip
fi

cd "opencv-${OPENCV_VERSION}"
mkdir -p build && cd build

echo "Configuring OpenCV..."

# Detect platform for platform-specific flags
PLATFORM_FLAGS=""
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS specific settings
    PLATFORM_FLAGS="-DCMAKE_OSX_DEPLOYMENT_TARGET=10.15"

    # For Apple Silicon cross-compilation support
    if [[ "$(uname -m)" == "arm64" ]]; then
        PLATFORM_FLAGS="${PLATFORM_FLAGS} -DCMAKE_OSX_ARCHITECTURES=arm64"
    else
        PLATFORM_FLAGS="${PLATFORM_FLAGS} -DCMAKE_OSX_ARCHITECTURES=x86_64"
    fi
fi

cmake .. \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX="${INSTALL_DIR}" \
    \
    -DBUILD_SHARED_LIBS=OFF \
    -DCMAKE_POSITION_INDEPENDENT_CODE=ON \
    \
    -DBUILD_LIST=core,imgproc,imgcodecs,video \
    \
    -DWITH_JPEG=ON \
    -DWITH_PNG=ON \
    -DWITH_WEBP=ON \
    -DBUILD_ZLIB=ON \
    -DBUILD_PNG=ON \
    -DBUILD_JPEG=ON \
    -DBUILD_WEBP=ON \
    \
    -DWITH_TIFF=OFF \
    -DWITH_OPENJPEG=OFF \
    -DWITH_JASPER=OFF \
    -DWITH_OPENEXR=OFF \
    -DWITH_IMGCODEC_HDR=OFF \
    -DWITH_IMGCODEC_SUNRASTER=OFF \
    -DWITH_IMGCODEC_PXM=OFF \
    -DWITH_IMGCODEC_PFM=OFF \
    \
    -DWITH_FFMPEG=OFF \
    -DWITH_GSTREAMER=OFF \
    -DWITH_V4L=OFF \
    -DWITH_DSHOW=OFF \
    -DWITH_MSMF=OFF \
    -DWITH_AVFOUNDATION=OFF \
    \
    -DWITH_OPENCL=OFF \
    -DWITH_CUDA=OFF \
    -DWITH_VULKAN=OFF \
    \
    -DWITH_GTK=OFF \
    -DWITH_QT=OFF \
    -DWITH_VTK=OFF \
    -DWITH_WIN32UI=OFF \
    \
    -DWITH_EIGEN=OFF \
    -DWITH_LAPACK=OFF \
    -DWITH_IPP=OFF \
    -DWITH_TBB=OFF \
    -DWITH_OPENMP=OFF \
    -DWITH_PTHREADS_PF=ON \
    \
    -DWITH_PROTOBUF=OFF \
    -DWITH_QUIRC=OFF \
    -DWITH_FLATBUFFERS=OFF \
    \
    -DBUILD_opencv_python2=OFF \
    -DBUILD_opencv_python3=OFF \
    -DBUILD_opencv_java=OFF \
    -DBUILD_opencv_js=OFF \
    \
    -DBUILD_TESTS=OFF \
    -DBUILD_PERF_TESTS=OFF \
    -DBUILD_EXAMPLES=OFF \
    -DBUILD_DOCS=OFF \
    -DBUILD_opencv_apps=OFF \
    \
    -DOPENCV_GENERATE_PKGCONFIG=OFF \
    -DOPENCV_ENABLE_NONFREE=OFF \
    \
    ${PLATFORM_FLAGS}

echo "Building OpenCV..."
make -j"${JOBS}"

echo "Installing OpenCV..."
make install

echo "=========================================="
echo "OpenCV ${OPENCV_VERSION} built successfully!"
echo ""
echo "Static libraries installed to: ${INSTALL_DIR}"
echo ""
echo "To use with node-gyp:"
echo "  npx node-gyp rebuild \\"
echo "    --opencv_include_dir=${INSTALL_DIR}/include/opencv4 \\"
echo "    --opencv_lib_dir=${INSTALL_DIR}/lib"
echo ""
echo "Libraries built:"
find "${INSTALL_DIR}/lib" -name "*.a" -type f 2>/dev/null | head -20 || echo "No .a files found"
echo ""
echo "3rdparty libraries:"
find "${INSTALL_DIR}/lib/opencv4/3rdparty" -name "*.a" -type f 2>/dev/null | head -10 || echo "(check ${INSTALL_DIR}/lib/opencv4/3rdparty/)"
echo "=========================================="
