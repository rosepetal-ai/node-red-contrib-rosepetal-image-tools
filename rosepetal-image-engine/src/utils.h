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
  int quality = 90)
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
      std::vector<int> params{
        cv::IMWRITE_PNG_COMPRESSION, 6,  // Balanced compression
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

  // Copy data
  size_t bytes = m.total() * m.elemSize();
  auto* raw = new uint8_t[bytes];
  std::memcpy(raw, m.data, bytes);

  o.Set("data", Napi::Buffer<uint8_t>::New(
    env, raw, bytes,
    [](Napi::Env, uint8_t* p) { delete[] p; }));
  
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





#endif // UTILS_H