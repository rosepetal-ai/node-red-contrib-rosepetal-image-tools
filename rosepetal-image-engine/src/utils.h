// Fichero: src/utils.h

#ifndef UTILS_H
#define UTILS_H

#include <napi.h>
#include <opencv2/opencv.hpp>
#include <vector>
#include <string>

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

#endif // UTILS_H
