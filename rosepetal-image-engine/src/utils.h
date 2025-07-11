// Fichero: src/utils.h

#ifndef UTILS_H
#define UTILS_H

#include <napi.h>
#include <opencv2/opencv.hpp>
#include <vector>
#include <string>
#include <chrono>

/**
 * Convierte cualquier entrada JS (Buffer de imagen codificada
 * o imagen cruda { data, width, height, channels }) a cv::Mat.
 * NO altera el orden BGR/RGB ni la profundidad.
 */
inline cv::Mat ConvertToMat(const Napi::Value& input) {
  Napi::Env env = input.Env();

  // --- 1. Objeto crudo -----------------------------------------------------
  if (input.IsObject() && !input.IsBuffer()) {
    Napi::Object obj = input.As<Napi::Object>();
    if (obj.Has("data") && obj.Has("width") && obj.Has("height")
        && obj.Has("channels")) {

      auto dataBuf  = obj.Get("data").As<Napi::Buffer<uint8_t>>();
      int  width    = obj.Get("width").As<Napi::Number>().Int32Value();
      int  height   = obj.Get("height").As<Napi::Number>().Int32Value();
      std::string ch = obj.Get("channels").As<Napi::String>().Utf8Value();

      // Determinar tipo OpenCV por canales (profundidad siempre 8 bits aquí)
      int cvType = CV_8UC3;
      if (ch.find("RGBA") != std::string::npos)      cvType = CV_8UC4;
      else if (ch.find("BGRA") != std::string::npos) cvType = CV_8UC4;
      else if (ch.find("GRAY") != std::string::npos) cvType = CV_8UC1;

      return cv::Mat(height, width, cvType, dataBuf.Data());
    }
  }

  // --- 2. Buffer de fichero (JPEG/PNG/WebP…) -------------------------------
  if (input.IsBuffer()) {
    auto buf  = input.As<Napi::Buffer<uint8_t>>();
    cv::Mat tmp(1, buf.Length(), CV_8UC1, buf.Data());
    cv::Mat img = cv::imdecode(tmp, cv::IMREAD_UNCHANGED);

    if (img.empty()) {
      throw Napi::Error::New(env, "Failed to decode image buffer.");
    }
    return img;  // BGR/BGRA/GRAY según fichero; no se altera
  }

  throw Napi::Error::New(env,
      "Invalid input: Expected Buffer or raw image object.");
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


// utils.h  – función de compresión rápido a “.jpg”
inline double EncodeToJpgFast(const cv::Mat& src,
  std::vector<uchar>& out,
  int quality = 100)
{
auto t0 = std::chrono::steady_clock::now();

std::vector<int> params{ cv::IMWRITE_JPEG_QUALITY, quality };
cv::imencode(".jpg", src, out, params);   // ← extensión “.jpg”

auto t1 = std::chrono::steady_clock::now();
return std::chrono::duration<double, std::milli>(t1 - t0).count();
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

// Pasa un cv::Mat 8-bit/16-bit a objeto raw {width,height,channels,data}.
inline Napi::Object MatToRawJS(Napi::Env env,
  const cv::Mat& m,
  const std::string& order)
{
Napi::Object o = Napi::Object::New(env);
o.Set("width",  Napi::Number::New(env, m.cols));
o.Set("height", Napi::Number::New(env, m.rows));

std::string depth = (m.depth() == CV_16U) ? "int16" : "int8";
o.Set("channels", Napi::String::New(env, depth + "_" + order));

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
