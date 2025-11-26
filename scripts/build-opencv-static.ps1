# Build minimal static OpenCV for Windows pre-built binary distribution
# Usage: .\build-opencv-static.ps1 [-BuildDir <path>] [-InstallDir <path>]
#
# This script builds OpenCV with only the modules needed by rosepetal-image-engine:
# - core, imgproc, imgcodecs
# - Bundled: libjpeg-turbo, libpng, libwebp, zlib

param(
    [string]$BuildDir = "C:\opencv-build",
    [string]$InstallDir = "C:\opencv-static",
    [string]$OpenCVVersion = "4.9.0",
    [string]$VSGenerator = "Visual Studio 17 2022",
    [string]$Architecture = "x64"
)

$ErrorActionPreference = "Stop"

Write-Host "=========================================="
Write-Host "Building OpenCV $OpenCVVersion (static)"
Write-Host "Build dir:   $BuildDir"
Write-Host "Install dir: $InstallDir"
Write-Host "Generator:   $VSGenerator"
Write-Host "Architecture: $Architecture"
Write-Host "=========================================="

# Create directories
New-Item -ItemType Directory -Force -Path $BuildDir | Out-Null
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

Set-Location $BuildDir

# Download OpenCV if not present
$OpenCVDir = "opencv-$OpenCVVersion"
if (-not (Test-Path $OpenCVDir)) {
    Write-Host "Downloading OpenCV $OpenCVVersion..."
    $ZipFile = "opencv.zip"
    Invoke-WebRequest -Uri "https://github.com/opencv/opencv/archive/refs/tags/$OpenCVVersion.zip" -OutFile $ZipFile
    Expand-Archive -Path $ZipFile -DestinationPath . -Force
    Remove-Item $ZipFile
}

Set-Location "$OpenCVDir"
New-Item -ItemType Directory -Force -Path "build" | Out-Null
Set-Location "build"

Write-Host "Configuring OpenCV..."

$CMakeArgs = @(
    "..",
    "-G", $VSGenerator,
    "-A", $Architecture,
    "-DCMAKE_BUILD_TYPE=Release",
    "-DCMAKE_INSTALL_PREFIX=$InstallDir",

    # Static build
    "-DBUILD_SHARED_LIBS=OFF",
    "-DCMAKE_POSITION_INDEPENDENT_CODE=ON",

    # Only required modules
    "-DBUILD_LIST=core,imgproc,imgcodecs",

    # Image format support (bundled)
    "-DWITH_JPEG=ON",
    "-DWITH_PNG=ON",
    "-DWITH_WEBP=ON",
    "-DBUILD_ZLIB=ON",
    "-DBUILD_PNG=ON",
    "-DBUILD_JPEG=ON",
    "-DBUILD_WEBP=ON",

    # Disable unused image formats
    "-DWITH_TIFF=OFF",
    "-DWITH_OPENJPEG=OFF",
    "-DWITH_JASPER=OFF",
    "-DWITH_OPENEXR=OFF",
    "-DWITH_IMGCODEC_HDR=OFF",
    "-DWITH_IMGCODEC_SUNRASTER=OFF",
    "-DWITH_IMGCODEC_PXM=OFF",
    "-DWITH_IMGCODEC_PFM=OFF",

    # Disable video/capture
    "-DWITH_FFMPEG=OFF",
    "-DWITH_GSTREAMER=OFF",
    "-DWITH_V4L=OFF",
    "-DWITH_DSHOW=OFF",
    "-DWITH_MSMF=OFF",

    # Disable GPU
    "-DWITH_OPENCL=OFF",
    "-DWITH_CUDA=OFF",
    "-DWITH_VULKAN=OFF",

    # Disable GUI
    "-DWITH_GTK=OFF",
    "-DWITH_QT=OFF",
    "-DWITH_VTK=OFF",
    "-DWITH_WIN32UI=OFF",

    # Disable extra features
    "-DWITH_EIGEN=OFF",
    "-DWITH_LAPACK=OFF",
    "-DWITH_IPP=OFF",
    "-DWITH_TBB=OFF",
    "-DWITH_OPENMP=OFF",
    "-DWITH_PROTOBUF=OFF",
    "-DWITH_QUIRC=OFF",
    "-DWITH_FLATBUFFERS=OFF",

    # Disable bindings
    "-DBUILD_opencv_python2=OFF",
    "-DBUILD_opencv_python3=OFF",
    "-DBUILD_opencv_java=OFF",
    "-DBUILD_opencv_js=OFF",

    # Disable tests and docs
    "-DBUILD_TESTS=OFF",
    "-DBUILD_PERF_TESTS=OFF",
    "-DBUILD_EXAMPLES=OFF",
    "-DBUILD_DOCS=OFF",
    "-DBUILD_opencv_apps=OFF",

    # Misc
    "-DOPENCV_GENERATE_PKGCONFIG=OFF",
    "-DOPENCV_ENABLE_NONFREE=OFF",

    # Windows specific: use static runtime
    "-DBUILD_WITH_STATIC_CRT=ON"
)

& cmake $CMakeArgs

if ($LASTEXITCODE -ne 0) {
    throw "CMake configuration failed"
}

Write-Host "Building OpenCV..."
& cmake --build . --config Release --parallel

if ($LASTEXITCODE -ne 0) {
    throw "Build failed"
}

Write-Host "Installing OpenCV..."
& cmake --install . --config Release

if ($LASTEXITCODE -ne 0) {
    throw "Install failed"
}

Write-Host "=========================================="
Write-Host "OpenCV $OpenCVVersion built successfully!"
Write-Host ""
Write-Host "Static libraries installed to: $InstallDir"
Write-Host ""
Write-Host "To use with node-gyp:"
Write-Host "  npx node-gyp rebuild \"
Write-Host "    --opencv_include_dir=$InstallDir\include\opencv4 \"
Write-Host "    --opencv_lib_dir=$InstallDir\x64\vc17\staticlib"
Write-Host ""
Write-Host "Libraries built:"
Get-ChildItem "$InstallDir\x64\vc17\staticlib\*.lib" | Select-Object Name, Length
Write-Host "=========================================="
