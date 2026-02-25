// Fichero: src/utils.h

#ifndef UTILS_H
#define UTILS_H

#include <napi.h>
#include <opencv2/opencv.hpp>
#include <vector>
#include <string>
#include <chrono>

/**
 * Converts JS input to cv::Mat supporting:
 * - Image object: {data, width, height, channels, colorSpace, dtype}
 * - Buffer: Raw image file data (JPEG/PNG/WebP)
 */
inline cv::Mat ConvertToMat(const Napi::Value& input) {
  Napi::Env env = input.Env();

  // --- 1. Raw image object -------------------------
  if (input.IsObject() && !input.IsBuffer()) {
    Napi::Object obj = input.As<Napi::Object>();
    if (obj.Has("data") && obj.Has("width") && obj.Has("height")) {

      auto dataBuf = obj.Get("data").As<Napi::Buffer<uint8_t>>();
      
      int width = obj.Get("width").As<Napi::Number>().Int32Value();
      int height = obj.Get("height").As<Napi::Number>().Int32Value();

      // Determine channel count and color space
      int channels = 3;  // default
      std::string colorSpace = "RGB";  // default
      
      if (obj.Has("channels")) {
        auto channelsVal = obj.Get("channels");
        
        if (channelsVal.IsNumber()) {
          channels = channelsVal.As<Napi::Number>().Int32Value();
          
          // Get colorSpace if available
          if (obj.Has("colorSpace")) {
            colorSpace = obj.Get("colorSpace").As<Napi::String>().Utf8Value();
          } else {
            // Default colorSpace based on channels
            switch (channels) {
              case 1: colorSpace = "GRAY"; break;
              case 3: colorSpace = "RGB"; break;
              case 4: colorSpace = "RGBA"; break;
              default: 
                throw Napi::Error::New(env, "Unsupported channel count: " + std::to_string(channels));
            }
          }
        } else {
          throw Napi::Error::New(env, "Channels must be a number");
        }
      }

      // Determine OpenCV type based on dtype and channels
      int cvType = CV_8UC3;  // default
      
      if (obj.Has("dtype")) {
        std::string dtype = obj.Get("dtype").As<Napi::String>().Utf8Value();
        if (dtype == "uint8") {
          switch (channels) {
            case 1: cvType = CV_8UC1; break;
            case 3: cvType = CV_8UC3; break;
            case 4: cvType = CV_8UC4; break;
            default: throw Napi::Error::New(env, "Unsupported channel count for uint8: " + std::to_string(channels));
          }
        } else if (dtype == "uint16") {
          switch (channels) {
            case 1: cvType = CV_16UC1; break;
            case 3: cvType = CV_16UC3; break;
            case 4: cvType = CV_16UC4; break;
            default: throw Napi::Error::New(env, "Unsupported channel count for uint16: " + std::to_string(channels));
          }
        } else if (dtype == "float32") {
          switch (channels) {
            case 1: cvType = CV_32FC1; break;
            case 3: cvType = CV_32FC3; break;
            case 4: cvType = CV_32FC4; break;
            default: throw Napi::Error::New(env, "Unsupported channel count for float32: " + std::to_string(channels));
          }
        } else {
          throw Napi::Error::New(env, "Unsupported dtype: " + dtype);
        }
      } else {
        // Default uint8 handling
        switch (channels) {
          case 1: cvType = CV_8UC1; break;
          case 3: cvType = CV_8UC3; break;
          case 4: cvType = CV_8UC4; break;
          default: throw Napi::Error::New(env, "Unsupported channel count: " + std::to_string(channels));
        }
      }

      return cv::Mat(height, width, cvType, dataBuf.Data());
    }
  }

  // --- 2. Direct Buffer (JPEG/PNG/WebP file data) -------------------------
  if (input.IsBuffer()) {
    auto buf = input.As<Napi::Buffer<uint8_t>>();
    cv::Mat tmp(1, buf.Length(), CV_8UC1, buf.Data());
    cv::Mat img = cv::imdecode(tmp, cv::IMREAD_UNCHANGED);

    if (img.empty()) {
      throw Napi::Error::New(env, "Failed to decode image buffer.");
    }
    return img;  // BGR/BGRA/GRAY according to file format
  }

  throw Napi::Error::New(env,
      "Invalid input: Expected Buffer or image object with {data, width, height}.");
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
  WEBP = 3
};

// Convert format string to enum
inline ImageFormat ParseImageFormat(const std::string& format) {
  if (format == "jpg" || format == "jpeg") return ImageFormat::JPG;
  if (format == "png") return ImageFormat::PNG;
  if (format == "webp") return ImageFormat::WEBP;
  return ImageFormat::RAW;
}

// Convert to the correct channel order for OpenCV's encoders.
// - JPG: requires BGR (alpha is dropped)
// - PNG/WebP: support BGR/BGRA (alpha preserved for *A variants)
inline cv::Mat PrepareForEncoding(const cv::Mat& src,
  const std::string& order,
  const std::string& outputFormat)
{
  const ImageFormat fmt = ParseImageFormat(outputFormat);
  if (fmt == ImageFormat::JPG) {
    return ToBgrForJpg(src, order);
  }

  // PNG/WebP: keep alpha when present
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

// Helper function to detect channel format for individual images (shared between blend and concat)
inline std::string DetectChannelFormatShared(const Napi::Value& jsImg, const cv::Mat& mat) {
  if (jsImg.IsObject() && !jsImg.IsBuffer()) {
    Napi::Object obj = jsImg.As<Napi::Object>();
    
    // Check for colorSpace field first
    if (obj.Has("colorSpace")) {
      return obj.Get("colorSpace").As<Napi::String>().Utf8Value();
    }
    // Default based on channel count
    else {
      const int channels = mat.channels();
      return (channels == 4) ? "RGBA" : (channels == 3) ? "RGB" : "GRAY";
    }
  } else {
    // Buffer input - determine from OpenCV Mat
    const int channels = mat.channels();
    return (channels == 4) ? "RGBA" : (channels == 3) ? "RGB" : "GRAY";
  }
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
  
  // Create mask based on color distance in HSV space
  cv::Mat mask = cv::Mat::zeros(hsv_src.size(), CV_8UC1);
  
  // Calculate tolerance thresholds
  double h_tolerance = tolerance * 180; // Hue range: 0-180
  double s_tolerance = tolerance * 255; // Saturation range: 0-255
  double v_tolerance = tolerance * 255; // Value range: 0-255
  
  for (int y = 0; y < hsv_src.rows; y++) {
    for (int x = 0; x < hsv_src.cols; x++) {
      cv::Vec3b pixel_hsv = hsv_src.at<cv::Vec3b>(y, x);
      
      // Calculate distance in HSV space
      double h_diff = std::abs(pixel_hsv[0] - target_hsv[0]);
      double s_diff = std::abs(pixel_hsv[1] - target_hsv[1]);
      double v_diff = std::abs(pixel_hsv[2] - target_hsv[2]);
      
      // Handle hue wraparound (0 and 180 are close)
      if (h_diff > 90) h_diff = 180 - h_diff;
      
      // Check if pixel matches background color within tolerance
      if (h_diff <= h_tolerance && s_diff <= s_tolerance && v_diff <= v_tolerance) {
        mask.at<uchar>(y, x) = 255; // Mark for removal
      }
    }
  }
  
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
  
  // Perform alpha compositing pixel by pixel
  for (int y = 0; y < result.rows; y++) {
    for (int x = 0; x < result.cols; x++) {
      cv::Vec4b base_pixel = base_bgra.at<cv::Vec4b>(y, x);
      cv::Vec4b overlay_pixel = overlay_bgra.at<cv::Vec4b>(y, x);
      
      // Normalize alpha values [0, 1]
      double base_alpha = base_pixel[3] / 255.0;
      double overlay_alpha = (overlay_pixel[3] / 255.0) * overlayOpacity;
      
      // Alpha compositing formula: result = overlay * overlay_alpha + base * (1 - overlay_alpha)
      // But we need to handle the case where overlay is transparent
      double result_alpha = overlay_alpha + base_alpha * (1.0 - overlay_alpha);
      
      cv::Vec4b result_pixel;
      
      if (result_alpha > 0.001) { // Avoid division by very small numbers
        for (int c = 0; c < 3; c++) { // BGR channels
          double result_color = (overlay_pixel[c] * overlay_alpha + 
                               base_pixel[c] * base_alpha * (1.0 - overlay_alpha)) / result_alpha;
          result_pixel[c] = cv::saturate_cast<uchar>(result_color);
        }
        result_pixel[3] = cv::saturate_cast<uchar>(result_alpha * 255);
      } else {
        // Fully transparent
        result_pixel = cv::Vec4b(0, 0, 0, 0);
      }
      
      result.at<cv::Vec4b>(y, x) = result_pixel;
    }
  }
  
  return result;
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
