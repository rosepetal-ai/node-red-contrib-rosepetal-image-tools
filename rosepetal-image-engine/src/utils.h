// Fichero: src/utils.h

#ifndef UTILS_H
#define UTILS_H

#include <napi.h>
#include <opencv2/opencv.hpp>
#include <vector>
#include <string>
#include <chrono>
#include <stdexcept>

/**
 * ImageSource — a JS image input captured on the JS thread, decoded on the
 * worker thread.
 *
 * Supported inputs:
 *  - Raw image object {data, width, height, channels, colorSpace, dtype}:
 *    the cv::Mat is a zero-copy view over the JS Buffer. `mat` and
 *    `colorSpace` are valid immediately after CaptureImage().
 *  - Encoded Buffer (JPEG/PNG/WebP/BMP...): only the pointer/length are
 *    captured. Nothing is decoded until Materialize() is called, which MUST
 *    happen inside AsyncWorker::Execute() so cv::imdecode never blocks the
 *    Node.js event loop.
 *
 * A persistent reference to the JS Buffer keeps its memory alive for the
 * whole lifetime of the worker (the reference is released on the JS thread
 * when the worker is destroyed).
 */
struct ImageSource {
  cv::Mat mat;                 // raw: zero-copy view; encoded: filled by Materialize()
  std::string colorSpace;      // "GRAY" | "RGB" | "RGBA" | "BGR" | "BGRA"
  bool encoded = false;
  const uchar* encPtr = nullptr;
  size_t encLen = 0;
  Napi::ObjectReference ref;   // keeps the JS Buffer alive (move-only)

  ImageSource() = default;
  ImageSource(ImageSource&&) = default;
  ImageSource& operator=(ImageSource&&) = default;
  ImageSource(const ImageSource&) = delete;
  ImageSource& operator=(const ImageSource&) = delete;

  bool IsEncoded() const { return encoded; }
  bool Ready() const { return !mat.empty(); }

  // Worker-thread only. Decodes an encoded buffer (no-op for raw inputs).
  // Throws std::runtime_error if the buffer cannot be decoded.
  void Materialize() {
    if (!encoded || !mat.empty()) return;
    if (encPtr == nullptr || encLen == 0) {
      throw std::runtime_error("Failed to decode image buffer: empty buffer.");
    }
    cv::Mat tmp(1, static_cast<int>(encLen), CV_8UC1, const_cast<uchar*>(encPtr));
    cv::Mat img = cv::imdecode(tmp, cv::IMREAD_UNCHANGED);
    if (img.empty()) {
      throw std::runtime_error("Failed to decode image buffer.");
    }
    // imdecode returns BGR/BGRA regardless of file format; the toolkit
    // labels decoded buffers as RGB/RGBA so we swap once here.
    if (img.channels() == 3)      cv::cvtColor(img, img, cv::COLOR_BGR2RGB);
    else if (img.channels() == 4) cv::cvtColor(img, img, cv::COLOR_BGRA2RGBA);
    mat = img;
    colorSpace = (img.channels() == 4) ? "RGBA" : (img.channels() == 3) ? "RGB" : "GRAY";
  }
};

// Resolves the pointer/length of a Buffer / TypedArray / ArrayBuffer value.
inline bool ResolveBytes(const Napi::Value& v, const uchar*& ptr, size_t& len) {
  if (v.IsBuffer()) {
    auto b = v.As<Napi::Buffer<uint8_t>>();
    ptr = b.Data(); len = b.Length();
    return true;
  }
  if (v.IsTypedArray()) {
    auto ta = v.As<Napi::TypedArray>();
    auto ab = ta.ArrayBuffer();
    ptr = static_cast<const uchar*>(ab.Data()) + ta.ByteOffset();
    len = ta.ByteLength();
    return true;
  }
  if (v.IsArrayBuffer()) {
    auto ab = v.As<Napi::ArrayBuffer>();
    ptr = static_cast<const uchar*>(ab.Data()); len = ab.ByteLength();
    return true;
  }
  return false;
}

/**
 * Captures a JS image input on the JS thread. Performs NO decoding and NO
 * pixel work — only reads metadata and takes a persistent reference.
 * Throws Napi::Error on invalid input.
 */
inline ImageSource CaptureImage(const Napi::Value& input) {
  Napi::Env env = input.Env();
  ImageSource src;

  // --- 1. Raw image object -------------------------
  if (input.IsObject() && !input.IsBuffer() && !input.IsTypedArray() && !input.IsArrayBuffer()) {
    Napi::Object obj = input.As<Napi::Object>();
    if (obj.Has("data") && obj.Has("width") && obj.Has("height")) {
      Napi::Value dataVal = obj.Get("data");
      const uchar* ptr = nullptr; size_t len = 0;
      if (!ResolveBytes(dataVal, ptr, len)) {
        throw Napi::Error::New(env, "Image data must be a Buffer or TypedArray");
      }

      int width = obj.Get("width").As<Napi::Number>().Int32Value();
      int height = obj.Get("height").As<Napi::Number>().Int32Value();
      if (width <= 0 || height <= 0) {
        throw Napi::Error::New(env, "Invalid image dimensions");
      }

      // Determine channel count and color space
      int channels = 3;  // default
      std::string colorSpace;

      if (obj.Has("channels")) {
        auto channelsVal = obj.Get("channels");
        if (channelsVal.IsNumber()) {
          channels = channelsVal.As<Napi::Number>().Int32Value();
        } else {
          throw Napi::Error::New(env, "Channels must be a number");
        }
      }
      if (obj.Has("colorSpace") && obj.Get("colorSpace").IsString()) {
        colorSpace = obj.Get("colorSpace").As<Napi::String>().Utf8Value();
      } else {
        switch (channels) {
          case 1: colorSpace = "GRAY"; break;
          case 3: colorSpace = "RGB"; break;
          case 4: colorSpace = "RGBA"; break;
          default:
            throw Napi::Error::New(env, "Unsupported channel count: " + std::to_string(channels));
        }
      }

      // Determine OpenCV type based on dtype and channels
      int cvType = CV_8UC3;  // default
      size_t elemBytes = 1;
      std::string dtype = "uint8";
      if (obj.Has("dtype") && obj.Get("dtype").IsString()) {
        dtype = obj.Get("dtype").As<Napi::String>().Utf8Value();
      }
      if (dtype == "uint8") {
        elemBytes = 1;
        switch (channels) {
          case 1: cvType = CV_8UC1; break;
          case 3: cvType = CV_8UC3; break;
          case 4: cvType = CV_8UC4; break;
          default: throw Napi::Error::New(env, "Unsupported channel count for uint8: " + std::to_string(channels));
        }
      } else if (dtype == "uint16") {
        elemBytes = 2;
        switch (channels) {
          case 1: cvType = CV_16UC1; break;
          case 3: cvType = CV_16UC3; break;
          case 4: cvType = CV_16UC4; break;
          default: throw Napi::Error::New(env, "Unsupported channel count for uint16: " + std::to_string(channels));
        }
      } else if (dtype == "float32") {
        elemBytes = 4;
        switch (channels) {
          case 1: cvType = CV_32FC1; break;
          case 3: cvType = CV_32FC3; break;
          case 4: cvType = CV_32FC4; break;
          default: throw Napi::Error::New(env, "Unsupported channel count for float32: " + std::to_string(channels));
        }
      } else {
        throw Napi::Error::New(env, "Unsupported dtype: " + dtype);
      }

      const size_t expected = static_cast<size_t>(width) * static_cast<size_t>(height) *
                              static_cast<size_t>(channels) * elemBytes;
      if (len < expected) {
        throw Napi::Error::New(env,
          "Image data too small: expected " + std::to_string(expected) +
          " bytes, got " + std::to_string(len));
      }

      src.mat = cv::Mat(height, width, cvType, const_cast<uchar*>(ptr));
      src.colorSpace = colorSpace;
      src.ref = Napi::Persistent(dataVal.As<Napi::Object>());
      return src;
    }
  }

  // --- 2. Encoded bytes (JPEG/PNG/WebP/BMP file data) -------------------------
  {
    const uchar* ptr = nullptr; size_t len = 0;
    if (ResolveBytes(input, ptr, len)) {
      src.encoded = true;
      src.encPtr = ptr;
      src.encLen = len;
      src.ref = Napi::Persistent(input.As<Napi::Object>());
      return src;
    }
  }

  throw Napi::Error::New(env,
      "Invalid input: Expected Buffer or image object with {data, width, height}.");
}

// Worker-thread helper: makes sure a result Mat owns contiguous memory so
// MatToRawJS() can hand it to JS with zero copies on the JS thread.
inline void FinalizeForOutput(cv::Mat& m) {
  if (m.empty()) return;
  if (!m.isContinuous() || m.u == nullptr) {
    m = m.clone();
  }
}

// Convierte a BGR 3-canales para JPEG si hace falta
inline cv::Mat ToBgrForJpg(const cv::Mat& src, const std::string& order) {
  if (src.channels() == 1 || order == "BGR") return src;          // ya OK
  cv::Mat dst;
  if (order == "RGB")  cv::cvtColor(src, dst, cv::COLOR_RGB2BGR);
  else if (order == "BGRA") cv::cvtColor(src, dst, cv::COLOR_BGRA2BGR);
  else if (order == "RGBA") cv::cvtColor(src, dst, cv::COLOR_RGBA2BGR);
  else dst = src;                                                 // fallback
  return dst;
}


// Multi-format image encoding system supporting JPG, PNG, WebP
enum class ImageFormat {
  RAW = 0,
  JPG = 1,
  PNG = 2,
  WEBP = 3,
  BMP = 4
};

// Convert format string to enum
inline ImageFormat ParseImageFormat(const std::string& format) {
  if (format == "jpg" || format == "jpeg") return ImageFormat::JPG;
  if (format == "png") return ImageFormat::PNG;
  if (format == "webp") return ImageFormat::WEBP;
  if (format == "bmp") return ImageFormat::BMP;
  return ImageFormat::RAW;
}

// Convert to the correct channel order for OpenCV's encoders.
// - JPG: requires BGR (alpha is dropped)
// - PNG/WebP/BMP: support BGR/BGRA (alpha preserved for *A variants)
inline cv::Mat PrepareForEncoding(const cv::Mat& src,
  const std::string& order,
  const std::string& outputFormat)
{
  const ImageFormat fmt = ParseImageFormat(outputFormat);
  if (fmt == ImageFormat::JPG) {
    return ToBgrForJpg(src, order);
  }

  // PNG/WebP/BMP: keep alpha when present
  if (src.channels() == 1 || order == "BGR" || order == "BGRA" || order == "GRAY") {
    return src;
  }

  cv::Mat dst;
  if (order == "RGB") {
    cv::cvtColor(src, dst, cv::COLOR_RGB2BGR);
  } else if (order == "RGBA") {
    cv::cvtColor(src, dst, cv::COLOR_RGBA2BGRA);
  } else {
    dst = src; // fallback (assume already in OpenCV-native order)
  }
  return dst;
}

// Fast JPEG compression function
inline double EncodeToJpgFast(const cv::Mat& src,
  std::vector<uchar>& out,
  int quality = 90)          // 90 = buen balance
{
  const int64 t0 = cv::getTickCount();

       // --- ruta OpenCV  ---------------------------
    out.reserve(src.total() >> 1);              // evita realloc (~50 %)
    std::vector<int> p{ cv::IMWRITE_JPEG_QUALITY, quality,
    cv::IMWRITE_JPEG_PROGRESSIVE, 0,
    cv::IMWRITE_JPEG_OPTIMIZE, 0 };
    cv::imencode(".jpg", src, out, p);


  return (cv::getTickCount() - t0) / cv::getTickFrequency() * 1e3;
}

// Enhanced multi-format encoding function
inline double EncodeToFormat(const cv::Mat& src,
  std::vector<uchar>& out,
  const std::string& format,
  int quality = 90,
  bool pngOptimize = false)
{
  const int64 t0 = cv::getTickCount();
  ImageFormat fmt = ParseImageFormat(format);
  
  switch (fmt) {
    case ImageFormat::JPG: {
      out.reserve(src.total() >> 1);
      std::vector<int> params{
        cv::IMWRITE_JPEG_QUALITY, quality,
        cv::IMWRITE_JPEG_PROGRESSIVE, 0,
        cv::IMWRITE_JPEG_OPTIMIZE, 0
      };
      cv::imencode(".jpg", src, out, params);
      break;
    }
    case ImageFormat::PNG: {
      out.reserve(src.total());
      // Use compression level 0 (fastest) when pngOptimize is false, 6 (balanced) when true
      int compressionLevel = pngOptimize ? 6 : 0;
      std::vector<int> params{
        cv::IMWRITE_PNG_COMPRESSION, compressionLevel,
        cv::IMWRITE_PNG_STRATEGY, cv::IMWRITE_PNG_STRATEGY_DEFAULT
      };
      cv::imencode(".png", src, out, params);
      break;
    }
    case ImageFormat::WEBP: {
      out.reserve(src.total() >> 1);
      std::vector<int> params{
        cv::IMWRITE_WEBP_QUALITY, quality
      };
      cv::imencode(".webp", src, out, params);
      break;
    }
    case ImageFormat::BMP: {
      // Uncompressed BI_RGB; 8-bit gray (palette), 24-bit BGR or 32-bit BGRA.
      out.reserve(src.total() * src.elemSize() + 1078);
      cv::imencode(".bmp", src, out);
      break;
    }
    default:
      // RAW format - should not reach here, handled at higher level
      throw std::runtime_error("RAW format encoding not supported");
  }
  
  return (cv::getTickCount() - t0) / cv::getTickFrequency() * 1e3;
}



// Devuelve "BGRA", "BGR" o "GRAY" a partir de "int8_BGRA", "int16_GRAY", etc.
inline std::string ExtractChannelOrder(const std::string& chFull) {
  auto pos = chFull.find('_');
  return pos == std::string::npos ? chFull : chFull.substr(pos + 1);
}


// Convierte "#RRGGBB" o "rgb(r,g,b)" → cv::Scalar(B,G,R).  Devuelve `def` si falla.
inline cv::Scalar ParseColor(const std::string& s,
  const cv::Scalar& def = {0,0,0})
{
if (s.empty()) return def;

if (s[0] == '#') {                       // forma #RRGGBB
unsigned v = std::stoul(s.substr(1), nullptr, 16);
return cv::Scalar(v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF);
}
int r, g, b;
if (std::sscanf(s.c_str(), "rgb(%d,%d,%d)", &r, &g, &b) == 3)
return cv::Scalar(b, g, r);

return def;
}

// Cede un std::vector<uchar> al JS sin copia (zero-copy).
inline Napi::Value VectorToBuffer(Napi::Env env, std::vector<uchar>&& v)
{
  auto* vec = new std::vector<uchar>(std::move(v));          // ⇢ heap
  return Napi::Buffer<uchar>::New(
      env, vec->data(), vec->size(),
      [](Napi::Env, uchar*, std::vector<uchar>* p) { delete p; }, vec);
}

// Converts cv::Mat to new JS format {width, height, channels, colorSpace, dtype, data}
inline Napi::Object MatToRawJS(Napi::Env env,
  const cv::Mat& m,
  const std::string& colorSpace)
{
  Napi::Object o = Napi::Object::New(env);
  o.Set("width",  Napi::Number::New(env, m.cols));
  o.Set("height", Napi::Number::New(env, m.rows));
  o.Set("channels", Napi::Number::New(env, m.channels()));
  o.Set("colorSpace", Napi::String::New(env, colorSpace));

  // Determine dtype from OpenCV depth
  std::string dtype;
  switch (m.depth()) {
    case CV_8U:  dtype = "uint8"; break;
    case CV_16U: dtype = "uint16"; break;
    case CV_32F: dtype = "float32"; break;
    default:     dtype = "uint8"; break;  // fallback
  }
  o.Set("dtype", Napi::String::New(env, dtype));

  // Zero-copy where possible:
  // - If Mat isn't continuous (ROI/step) or doesn't own its data (external ptr),
  //   clone to a contiguous owned buffer once.
  cv::Mat owned = m;
  if (!owned.isContinuous() || owned.u == nullptr) {
    owned = m.clone();
  }

  auto* heapMat = new cv::Mat(std::move(owned));
  const size_t bytes = heapMat->total() * heapMat->elemSize();

  o.Set("data", Napi::Buffer<uint8_t>::New(
    env,
    heapMat->data,
    bytes,
    [](Napi::Env, uint8_t*, cv::Mat* mat) { delete mat; },
    heapMat
  ));

  return o;
}

// Crea el objeto { convertMs, taskMs, encodeMs } para devolver a JS.
inline Napi::Object MakeTimingJS(Napi::Env env,
  double convertMs,
  double taskMs,
  double encodeMs = 0.0)
{
Napi::Object t = Napi::Object::New(env);
t.Set("convertMs", Napi::Number::New(env, convertMs));
t.Set("taskMs",    Napi::Number::New(env, taskMs));
t.Set("encodeMs",  Napi::Number::New(env, encodeMs));
return t;
}

// Helper function to convert image to target channel format (shared between blend and concat)
inline cv::Mat ConvertToTargetFormatShared(const cv::Mat& src, const std::string& srcFormat, const std::string& targetFormat) {
  if (srcFormat == targetFormat) {
    return src; // No conversion needed
  }
  
  cv::Mat dst;
  
  // Convert to target format
  if (srcFormat == "GRAY" && targetFormat == "BGR") {
    cv::cvtColor(src, dst, cv::COLOR_GRAY2BGR);
  } else if (srcFormat == "GRAY" && targetFormat == "RGB") {
    cv::cvtColor(src, dst, cv::COLOR_GRAY2RGB);
  } else if (srcFormat == "GRAY" && targetFormat == "BGRA") {
    cv::cvtColor(src, dst, cv::COLOR_GRAY2BGRA);
  } else if (srcFormat == "GRAY" && targetFormat == "RGBA") {
    cv::cvtColor(src, dst, cv::COLOR_GRAY2RGBA);
  } else if (srcFormat == "BGR" && targetFormat == "RGB") {
    cv::cvtColor(src, dst, cv::COLOR_BGR2RGB);
  } else if (srcFormat == "RGB" && targetFormat == "BGR") {
    cv::cvtColor(src, dst, cv::COLOR_RGB2BGR);
  } else if (srcFormat == "BGR" && targetFormat == "BGRA") {
    cv::cvtColor(src, dst, cv::COLOR_BGR2BGRA);
  } else if (srcFormat == "BGR" && targetFormat == "RGBA") {
    cv::cvtColor(src, dst, cv::COLOR_BGR2RGBA);
  } else if (srcFormat == "RGB" && targetFormat == "RGBA") {
    cv::cvtColor(src, dst, cv::COLOR_RGB2RGBA);
  } else if (srcFormat == "RGB" && targetFormat == "BGRA") {
    cv::cvtColor(src, dst, cv::COLOR_RGB2BGRA);
  } else if (srcFormat == "BGRA" && targetFormat == "BGR") {
    cv::cvtColor(src, dst, cv::COLOR_BGRA2BGR);
  } else if (srcFormat == "RGBA" && targetFormat == "RGB") {
    cv::cvtColor(src, dst, cv::COLOR_RGBA2RGB);
  } else if (srcFormat == "BGRA" && targetFormat == "RGBA") {
    cv::cvtColor(src, dst, cv::COLOR_BGRA2RGBA);
  } else if (srcFormat == "RGBA" && targetFormat == "BGRA") {
    cv::cvtColor(src, dst, cv::COLOR_RGBA2BGRA);
  } else {
    // Fallback: return source if no conversion available
    dst = src;
  }
  
  return dst;
}

// Helper function to determine the best output channel format from two inputs (shared between blend and add-mask)
inline std::string DetermineOutputFormat(const std::string& format1, const std::string& format2) {
  // Priority: RGBA > BGRA > RGB > BGR > GRAY
  if (format1 == "RGBA" || format2 == "RGBA") return "RGBA";
  if (format1 == "BGRA" || format2 == "BGRA") return "BGRA";
  if (format1 == "RGB" || format2 == "RGB") return "RGB";
  if (format1 == "BGR" || format2 == "BGR") return "BGR";
  return "GRAY";
}

// Background removal function - removes specified color with tolerance
inline cv::Mat removeColorBackground(const cv::Mat& src, const cv::Scalar& bgColor, double tolerance) {
  cv::Mat result;
  cv::Mat hsv_src, hsv_bg;
  
  // Validate input image channels
  int srcChannels = src.channels();
  if (srcChannels > 4) {
    throw std::runtime_error("Invalid image: too many channels (" + std::to_string(srcChannels) + "). Expected 1, 3, or 4 channels.");
  }
  
  // Convert source to HSV for better color matching
  if (srcChannels == 4) {
    // BGRA to HSV (ignore alpha channel for color matching)
    cv::cvtColor(src, hsv_src, cv::COLOR_BGRA2BGR);
    cv::cvtColor(hsv_src, hsv_src, cv::COLOR_BGR2HSV);
  } else if (srcChannels == 3) {
    // BGR to HSV
    cv::cvtColor(src, hsv_src, cv::COLOR_BGR2HSV);
  } else if (srcChannels == 1) {
    // Grayscale to HSV
    cv::Mat gray_bgr;
    cv::cvtColor(src, gray_bgr, cv::COLOR_GRAY2BGR);
    cv::cvtColor(gray_bgr, hsv_src, cv::COLOR_BGR2HSV);
  } else {
    throw std::runtime_error("Invalid image: unsupported channel count (" + std::to_string(srcChannels) + ")");
  }
  
  // Convert background color to HSV
  cv::Mat bg_mat = cv::Mat::ones(1, 1, CV_8UC3);
  bg_mat.at<cv::Vec3b>(0, 0) = cv::Vec3b((uchar)bgColor[2], (uchar)bgColor[1], (uchar)bgColor[0]); // BGR
  cv::cvtColor(bg_mat, hsv_bg, cv::COLOR_BGR2HSV);
  cv::Vec3b target_hsv = hsv_bg.at<cv::Vec3b>(0, 0);
  
  // Calculate tolerance thresholds
  double h_tolerance = tolerance * 180; // Hue range: 0-180
  double s_tolerance = tolerance * 255; // Saturation range: 0-255
  double v_tolerance = tolerance * 255; // Value range: 0-255

  // Mask of pixels within tolerance of the background colour, computed with
  // whole-image OpenCV operations (identical result to the former per-pixel
  // loop: |h-t| with wraparound, |s-t|, |v-t|, all <= tolerance).
  std::vector<cv::Mat> hsvCh;
  cv::split(hsv_src, hsvCh);
  cv::Mat hDiff, sDiff, vDiff;
  cv::absdiff(hsvCh[0], cv::Scalar(target_hsv[0]), hDiff);
  cv::absdiff(hsvCh[1], cv::Scalar(target_hsv[1]), sDiff);
  cv::absdiff(hsvCh[2], cv::Scalar(target_hsv[2]), vDiff);
  // Hue wraparound (0 and 180 are close): h = min(h, 180 - h)
  cv::Mat hWrap;
  cv::subtract(cv::Scalar(180), hDiff, hWrap);
  cv::min(hDiff, hWrap, hDiff);

  cv::Mat mh, ms, mv, mask;
  cv::compare(hDiff, h_tolerance, mh, cv::CMP_LE);
  cv::compare(sDiff, s_tolerance, ms, cv::CMP_LE);
  cv::compare(vDiff, v_tolerance, mv, cv::CMP_LE);
  cv::bitwise_and(mh, ms, mask);
  cv::bitwise_and(mask, mv, mask);   // 255 = mark for removal
  
  // Apply Gaussian blur to mask edges for smooth transitions
  if (tolerance > 0.01) {
    cv::GaussianBlur(mask, mask, cv::Size(5, 5), 1.0);
  }
  
  // Create BGRA result with proper channel handling
  std::vector<cv::Mat> channels;
  
  if (srcChannels == 1) {
    // Grayscale input - convert to BGR first
    cv::Mat bgr_src;
    cv::cvtColor(src, bgr_src, cv::COLOR_GRAY2BGR);
    cv::split(bgr_src, channels);
  } else if (srcChannels == 3) {
    // BGR input - use directly
    cv::split(src, channels);
  } else if (srcChannels == 4) {
    // BGRA input - use first 3 channels, ignore existing alpha
    cv::split(src, channels);
    channels.resize(3); // Keep only BGR channels
  }
  
  // Create alpha channel (inverse of mask - transparent where mask is white)
  cv::Mat alpha;
  cv::bitwise_not(mask, alpha);
  channels.push_back(alpha);
  
  // Merge to BGRA (should always have exactly 4 channels)
  cv::merge(channels, result);
  
  return result;
}

// Alpha compositing function - proper layered compositing
inline cv::Mat alphaComposite(const cv::Mat& base, const cv::Mat& overlay, double overlayOpacity) {
  cv::Mat result;
  
  // Validate input images
  if (base.channels() > 4 || overlay.channels() > 4) {
    throw std::runtime_error("Invalid images for alpha compositing: too many channels. Base: " + 
                            std::to_string(base.channels()) + ", Overlay: " + 
                            std::to_string(overlay.channels()));
  }
  
  // Ensure both images are in BGRA format for alpha compositing
  cv::Mat base_bgra, overlay_bgra;
  
  if (base.channels() == 4) {
    base_bgra = base;
  } else if (base.channels() == 3) {
    cv::cvtColor(base, base_bgra, cv::COLOR_BGR2BGRA);
  } else if (base.channels() == 1) {
    cv::cvtColor(base, base_bgra, cv::COLOR_GRAY2BGRA);
  } else {
    throw std::runtime_error("Unsupported base image channel count: " + std::to_string(base.channels()));
  }
  
  if (overlay.channels() == 4) {
    overlay_bgra = overlay;
  } else if (overlay.channels() == 3) {
    cv::cvtColor(overlay, overlay_bgra, cv::COLOR_BGR2BGRA);
  } else if (overlay.channels() == 1) {
    cv::cvtColor(overlay, overlay_bgra, cv::COLOR_GRAY2BGRA);
  } else {
    throw std::runtime_error("Unsupported overlay image channel count: " + std::to_string(overlay.channels()));
  }
  
  // Ensure same dimensions
  if (base_bgra.size() != overlay_bgra.size()) {
    cv::Size targetSize(std::max(base_bgra.cols, overlay_bgra.cols), 
                       std::max(base_bgra.rows, overlay_bgra.rows));
    if (base_bgra.size() != targetSize) {
      cv::resize(base_bgra, base_bgra, targetSize);
    }
    if (overlay_bgra.size() != targetSize) {
      cv::resize(overlay_bgra, overlay_bgra, targetSize);
    }
  }
  
  result = cv::Mat::zeros(base_bgra.size(), CV_8UC4);
  
  // Alpha compositing with row pointers (same arithmetic as the former
  // per-pixel .at<>() loop). Fully transparent results stay at zero.
  const int rows = result.rows, cols = result.cols;
  cv::parallel_for_(cv::Range(0, rows), [&](const cv::Range& range) {
    for (int y = range.start; y < range.end; y++) {
      const uchar* b = base_bgra.ptr<uchar>(y);
      const uchar* o = overlay_bgra.ptr<uchar>(y);
      uchar* r = result.ptr<uchar>(y);
      for (int x = 0; x < cols; x++, b += 4, o += 4, r += 4) {
        // Normalize alpha values [0, 1]
        const double base_alpha = b[3] / 255.0;
        const double overlay_alpha = (o[3] / 255.0) * overlayOpacity;
        
        // result = overlay * overlay_alpha + base * base_alpha * (1 - overlay_alpha)
        const double result_alpha = overlay_alpha + base_alpha * (1.0 - overlay_alpha);
        if (result_alpha <= 0.001) continue;   // fully transparent → (0,0,0,0)
        
        const double base_w = base_alpha * (1.0 - overlay_alpha);
        r[0] = cv::saturate_cast<uchar>((o[0] * overlay_alpha + b[0] * base_w) / result_alpha);
        r[1] = cv::saturate_cast<uchar>((o[1] * overlay_alpha + b[1] * base_w) / result_alpha);
        r[2] = cv::saturate_cast<uchar>((o[2] * overlay_alpha + b[2] * base_w) / result_alpha);
        r[3] = cv::saturate_cast<uchar>(result_alpha * 255);
      }
    }
  });
  
  return result;
}

// 216 candidate colours evenly spread over HSV (24 hues × 3 saturations × 3
// values), in BGR float [0,1]. Computed once per process instead of on every
// call (it used to cost 216 tiny cvtColor invocations per unmapped class).
inline const std::vector<cv::Vec3f>& CandidateColorPalette() {
  static const std::vector<cv::Vec3f> palette = []() {
    std::vector<cv::Vec3f> out;
    const int numHues = 24;        // Every 15 degrees
    const int numSaturations = 3;  // 60%, 80%, 100%
    const int numValues = 3;       // 60%, 80%, 100%
    out.reserve(numHues * numSaturations * numValues);
    for (int h = 0; h < numHues; h++) {
      for (int s = 0; s < numSaturations; s++) {
        for (int v = 0; v < numValues; v++) {
          float hue = (h * 360.0f / numHues);
          float saturation = 0.6f + s * 0.2f;
          float value = 0.6f + v * 0.2f;
          cv::Mat hsv(1, 1, CV_32FC3, cv::Scalar(hue / 360.0f, saturation, value));
          cv::Mat bgr;
          cv::cvtColor(hsv, bgr, cv::COLOR_HSV2BGR);
          out.push_back(bgr.at<cv::Vec3f>(0, 0));
        }
      }
    }
    return out;
  }();
  return palette;
}

// Parse color string to cv::Scalar, supporting hex colors
inline cv::Scalar parseColorString(const std::string& colorStr) {
  if (colorStr.empty()) {
    return cv::Scalar(255, 255, 255); // Default white
  }
  
  if (colorStr[0] == '#' && colorStr.length() == 7) {
    // Hex color #RRGGBB
    unsigned long rgb = std::stoul(colorStr.substr(1), nullptr, 16);
    return cv::Scalar((rgb & 0xFF), ((rgb >> 8) & 0xFF), ((rgb >> 16) & 0xFF)); // BGR
  }
  
  // Default fallback
  return cv::Scalar(255, 255, 255);
}

#endif // UTILS_H
