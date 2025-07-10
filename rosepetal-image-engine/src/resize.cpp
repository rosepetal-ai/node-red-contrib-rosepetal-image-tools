// Fichero: src/resize.cpp

#include <napi.h>
#include <opencv2/opencv.hpp>
#include <chrono>
#include <cstring>
#include <string>
#include <vector>
#include "utils.h"

class ResizeWorker : public Napi::AsyncWorker {
public:
  ResizeWorker(Napi::Function& callback,
               const Napi::Value& inputImage,
               int targetWidth,
               int targetHeight,
               bool encodeJpg)
      : Napi::AsyncWorker(callback),
        targetWidth(targetWidth),
        targetHeight(targetHeight),
        encodeJpg(encodeJpg) {

    try {
      auto t0 = std::chrono::steady_clock::now();
      inputMat = ConvertToMat(inputImage);
      auto t1 = std::chrono::steady_clock::now();
      convertMs = std::chrono::duration<double, std::milli>(t1 - t0).count();

      if (inputImage.IsObject() && !inputImage.IsBuffer()) {
        std::string chFull =
            inputImage.As<Napi::Object>().Get("channels").As<Napi::String>().Utf8Value();
        std::size_t pos = chFull.find('_');
        channelOrder = (pos != std::string::npos) ? chFull.substr(pos + 1) : chFull;
      } else {
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
      auto t0 = std::chrono::steady_clock::now();
      cv::resize(inputMat, resultMat,
                 cv::Size(targetWidth, targetHeight),
                 0, 0, cv::INTER_LINEAR);
      auto t1 = std::chrono::steady_clock::now();
      taskMs = std::chrono::duration<double, std::milli>(t1 - t0).count();

      if (encodeJpg) {
        cv::Mat jpgSrc = ToBgrForJpg(resultMat, channelOrder);
        encodeMs = EncodeToJpgFast(jpgSrc, jpgBuf);
      }
    } catch (const cv::Exception& e) {
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
  int targetWidth, targetHeight;
  std::string channelOrder;

  double convertMs = 0.0;
  double taskMs    = 0.0;

  bool encodeJpg;
  std::vector<uchar> jpgBuf;
  double encodeMs = 0.0;
};

Napi::Value Resize(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 4 || info.Length() > 5 || !info[info.Length() - 1].IsFunction()) {
    Napi::TypeError::New(env,
      "Expected (image, width, height, [encodeJpg], callback)")
      .ThrowAsJavaScriptException();
    return env.Null();
  }

  bool encodeJpg = false;
  size_t cbIndex  = 3;
  if (info.Length() == 5) {
    encodeJpg = info[3].As<Napi::Boolean>().Value();
    cbIndex    = 4;
  }

  Napi::Function cb = info[cbIndex].As<Napi::Function>();

  auto* worker = new ResizeWorker(
      cb,
      info[0],
      info[1].As<Napi::Number>().Int32Value(),
      info[2].As<Napi::Number>().Int32Value(),
      encodeJpg);

  worker->Queue();
  return env.Undefined();
}
