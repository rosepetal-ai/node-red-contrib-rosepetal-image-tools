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
  std::string outputFormat,
  int quality = 90)
  : Napi::AsyncWorker(callback),
  widthMode(std::move(widthMode)),   widthValue(widthValue),
  heightMode(std::move(heightMode)), heightValue(heightValue),
  outputFormat(std::move(outputFormat)), quality(quality){

    try {
      auto t0 = std::chrono::steady_clock::now();
      inputMat = ConvertToMat(inputImage);
      auto t1 = std::chrono::steady_clock::now();
      convertMs = std::chrono::duration<double, std::milli>(t1 - t0).count();

      if (inputImage.IsObject() && !inputImage.IsBuffer()) {
        Napi::Object obj = inputImage.As<Napi::Object>();
        
        // Check for colorSpace field
        if (obj.Has("colorSpace")) {
          channelOrder = obj.Get("colorSpace").As<Napi::String>().Utf8Value();
        }
        // Default based on channel count
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

        // --- 4.3 Multi-format encoding -----------------------------
        if (outputFormat != "raw") {
          // Convert to BGR if needed for encoding
          const cv::Mat& srcForEncoding =
                (channelOrder == "BGR") ? resultMat
                                        : ToBgrForJpg(resultMat, channelOrder);
      
          encodeMs = EncodeToFormat(srcForEncoding, encodedBuf, outputFormat, quality);
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
    if (outputFormat != "raw") {
        // Return encoded buffer (JPG/PNG/WebP)
        uint8_t* encodedData = new uint8_t[encodedBuf.size()];
        std::memcpy(encodedData, encodedBuf.data(), encodedBuf.size());
        imageResult = Napi::Buffer<uint8_t>::New(
            env, encodedData, encodedBuf.size(),
            [](Napi::Env, uint8_t* p){ delete[] p; }
        );
    } else {
        // Return raw image object using new format
        imageResult = MatToRawJS(env, resultMat, channelOrder);
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

  std::string outputFormat;
  int quality;
  std::vector<uchar> encodedBuf;
  double encodeMs = 0.0;
};

Napi::Value Resize(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

    if (info.Length() < 6 || info.Length() > 8 || !info[info.Length() - 1].IsFunction()) {
      Napi::TypeError::New(env,
        "Expected (image, widthMode, widthVal, heightMode, heightVal, [outputFormat], [quality], callback)")
        .ThrowAsJavaScriptException();
      return env.Null();
  }

  std::string outputFormat = "raw";
  int quality = 90;
  size_t cbIndex = 5;

  // Handle parameters
  if (info.Length() == 7) {
    outputFormat = info[5].As<Napi::String>().Utf8Value();
    cbIndex = 6;
  } else if (info.Length() == 8) {
    outputFormat = info[5].As<Napi::String>().Utf8Value();
    quality = info[6].As<Napi::Number>().Int32Value();
    cbIndex = 7;
  }

  Napi::Function cb = info[cbIndex].As<Napi::Function>();

  auto* worker = new ResizeWorker(
      cb,
      info[0],                                    // image
      info[1].As<Napi::String>().Utf8Value(),     // widthMode
      info[2].As<Napi::Number>().DoubleValue(),   // widthVal
      info[3].As<Napi::String>().Utf8Value(),     // heightMode
      info[4].As<Napi::Number>().DoubleValue(),   // heightVal
      outputFormat,                               // outputFormat
      quality);                                   // quality

  worker->Queue();
  return env.Undefined();
}
