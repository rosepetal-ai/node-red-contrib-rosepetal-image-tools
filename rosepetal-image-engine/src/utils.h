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



#endif // UTILS_H
