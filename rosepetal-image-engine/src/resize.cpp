// Fichero: src/resize.cpp

#include <napi.h>
#include <opencv2/opencv.hpp>
#include <chrono>
#include <cstring>
#include <string>
#include <vector>
#include <cmath>
#include <utility>  
#include <limits> 
#include "utils.h"

class ResizeWorker : public Napi::AsyncWorker {
public:
ResizeWorker(Napi::Function& callback,
  const Napi::Value& inputImage,
  std::string widthMode,  double widthValue,
  std::string heightMode, double heightValue,
  bool encodeJpg)
  : Napi::AsyncWorker(callback),
  widthMode(std::move(widthMode)),   widthValue(widthValue),
  heightMode(std::move(heightMode)), heightValue(heightValue),
  encodeJpg(encodeJpg){

    try {
      auto t0 = std::chrono::steady_clock::now();
      inputMat = ConvertToMat(inputImage);
      auto t1 = std::chrono::steady_clock::now();
      convertMs = std::chrono::duration<double, std::milli>(t1 - t0).count();

      if (inputImage.IsObject() && !inputImage.IsBuffer()) {
        Napi::Object obj = inputImage.As<Napi::Object>();
        
        // Check for new colorSpace field first
        if (obj.Has("colorSpace")) {
          channelOrder = obj.Get("colorSpace").As<Napi::String>().Utf8Value();
        }
        // Handle legacy string format
        else if (obj.Has("channels") && obj.Get("channels").IsString()) {
          std::string chFull = obj.Get("channels").As<Napi::String>().Utf8Value();
          std::size_t pos = chFull.find('_');
          channelOrder = (pos != std::string::npos) ? chFull.substr(pos + 1) : chFull;
        }
        // Default based on channel count for new numeric format
        else {
          channelOrder = (inputMat.channels() == 4) ? "BGRA"
                       : (inputMat.channels() == 3) ? "BGR"
                       : "GRAY";
        }
      } else {
        // Buffer input - determine from OpenCV Mat
        channelOrder = (inputMat.channels() == 4) ? "BGRA"
                     : (inputMat.channels() == 3) ? "BGR"
                     : "GRAY";
      }
    } catch (const Napi::Error& e) {
      SetError(e.Message());
    }
  }

protected:
  void Execute() override {
    try {
        // --- 4.1 Calcular ancho/alto objetivo --------------------------
        auto calcDim = [](int orig, const std::string& mode, double val) -> int {
          if (std::isnan(val)) return 0;  // Auto
          return mode == "multiply"
                 ? static_cast<int>(std::lround(orig * val))
                 : static_cast<int>(std::lround(val));
        };
      
        targetWidth  = calcDim(inputMat.cols, widthMode,  widthValue);
        targetHeight = calcDim(inputMat.rows, heightMode, heightValue);

        if (!targetWidth && !targetHeight)
            throw std::runtime_error("Both dimensions are Auto");

        if (!targetWidth)
            targetWidth  = std::lround(targetHeight *
                        (double)inputMat.cols / inputMat.rows);
        if (!targetHeight)
            targetHeight = std::lround(targetWidth  *
                        (double)inputMat.rows / inputMat.cols);

        // --- 4.2 Redimensionar ----------------------------------------
        auto t0 = std::chrono::steady_clock::now();
        cv::resize(inputMat, resultMat,
                  cv::Size(targetWidth, targetHeight),
                  0, 0, cv::INTER_LINEAR);
        auto t1 = std::chrono::steady_clock::now();
        taskMs = std::chrono::duration<double, std::milli>(t1 - t0).count();

        // --- 4.3 Codificación JPG (igual) -----------------------------
        if (encodeJpg) {
          // sólo convierte si el canal NO es BGR
          const cv::Mat& srcForJpg =
                (channelOrder == "BGR") ? resultMat
                                        : ToBgrForJpg(resultMat, channelOrder);
      
          encodeMs = EncodeToJpgFast(srcForJpg, jpgBuf, 90);  // usa nuevo helper
        }
    } catch (const std::exception& e) {
        SetError(e.what());
    }
  }


  // Fichero: src/resize.cpp (OnOK corregido y final)

  void OnOK() override {
    Napi::Env env = Env();
    Napi::Value imageResult; // Usamos un Napi::Value para guardar el resultado de la imagen

    // --- Lógica de la Imagen ---
    if (encodeJpg) {
        // Si se pidió un JPG, imageResult es SOLO el buffer del fichero.
        uint8_t* jpgData = new uint8_t[jpgBuf.size()];
        std::memcpy(jpgData, jpgBuf.data(), jpgBuf.size());
        imageResult = Napi::Buffer<uint8_t>::New(
            env, jpgData, jpgBuf.size(),
            [](Napi::Env, uint8_t* p){ delete[] p; }
        );
    } else {
        // Si se pidió raw, imageResult es el OBJETO raw completo.
        Napi::Object imageObj = Napi::Object::New(env);
        imageObj.Set("width",  Napi::Number::New(env, resultMat.cols));
        imageObj.Set("height", Napi::Number::New(env, resultMat.rows));
        
        std::string depth = (resultMat.depth() == CV_16U) ? "int16" : "int8";
        imageObj.Set("channels", Napi::String::New(env, depth + "_" + channelOrder));

        size_t bytes = resultMat.total() * resultMat.elemSize();
        uint8_t* rawData = new uint8_t[bytes];
        std::memcpy(rawData, resultMat.data, bytes);
        imageObj.Set("data", Napi::Buffer<uint8_t>::New(env, rawData, bytes, [](Napi::Env, uint8_t* p){ delete[] p; }));
        
        imageResult = imageObj;
    }

    // --- Lógica de Tiempos (siempre se añade) ---
    Napi::Object timingObj = Napi::Object::New(env);
    timingObj.Set("convertMs", Napi::Number::New(env, convertMs));
    timingObj.Set("taskMs",   Napi::Number::New(env, taskMs));
    timingObj.Set("encodeMs", Napi::Number::New(env, encodeMs));

    // --- Objeto Final (siempre tiene la misma estructura) ---
    Napi::Object finalResult = Napi::Object::New(env);
    finalResult.Set("image",  imageResult); // Contiene el Buffer JPG o el Objeto Raw
    finalResult.Set("timing", timingObj);

    Callback().Call({ env.Null(), finalResult });
  }

  void OnError(const Napi::Error& e) override {
    Callback().Call({ e.Value(), Env().Null() });
  }

private:
  cv::Mat inputMat, resultMat;
  int targetWidth = 0;
  int targetHeight = 0;
  std::string widthMode;  
  std::string heightMode;
  double widthValue  = std::numeric_limits<double>::quiet_NaN();
  double heightValue = std::numeric_limits<double>::quiet_NaN();


  std::string channelOrder;

  double convertMs = 0.0;
  double taskMs    = 0.0;

  bool encodeJpg;
  std::vector<uchar> jpgBuf;
  double encodeMs = 0.0;
};

Napi::Value Resize(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

    if (info.Length() < 6 || info.Length() > 7 || !info[info.Length() - 1].IsFunction()) {
      Napi::TypeError::New(env,
        "Expected (image, widthMode, widthVal, heightMode, heightVal, [encodeJpg], callback)")
        .ThrowAsJavaScriptException();
      return env.Null();
  }

  bool encodeJpg = false;
  size_t cbIndex = 5;
  if (info.Length() == 7) {
      encodeJpg = info[5].As<Napi::Boolean>().Value();
      cbIndex   = 6;
  }

  Napi::Function cb = info[cbIndex].As<Napi::Function>();

  auto* worker = new ResizeWorker(
      cb,
      info[0],                                    // image
      info[1].As<Napi::String>().Utf8Value(),     // widthMode
      info[2].As<Napi::Number>().DoubleValue(),   // widthVal
      info[3].As<Napi::String>().Utf8Value(),     // heightMode
      info[4].As<Napi::Number>().DoubleValue(),   // heightVal
      encodeJpg);

  worker->Queue();
  return env.Undefined();
}
