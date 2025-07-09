// Fichero: src/resize.cpp

#include <napi.h>
#include <opencv2/opencv.hpp>
#include <chrono>
#include <cstring>
#include <string>
#include "utils.h"

class ResizeWorker : public Napi::AsyncWorker {
public:
  ResizeWorker(Napi::Function& callback,
               const Napi::Value& inputImage,
               int targetWidth,
               int targetHeight)
      : Napi::AsyncWorker(callback),
        targetWidth(targetWidth),
        targetHeight(targetHeight) {

    try {
      // ── Tiempo ConvertToMat ──────────────────────────────────────────────
      auto t0 = std::chrono::steady_clock::now();
      this->inputMat = ConvertToMat(inputImage);
      auto t1 = std::chrono::steady_clock::now();
      convertMs = std::chrono::duration<double, std::milli>(t1 - t0).count();
      // --------------------------------------------------------------------

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
      Napi::AsyncWorker::SetError(e.Message());
    }
  }

protected:
  void Execute() override {
    try {
      auto t0 = std::chrono::steady_clock::now();  // ⏱️ inicio resize
      cv::resize(inputMat, resultMat,
                 cv::Size(targetWidth, targetHeight),
                 0, 0, cv::INTER_LINEAR);
      auto t1 = std::chrono::steady_clock::now();  // ⏱️ fin resize
      taskMs = std::chrono::duration<double, std::milli>(t1 - t0).count();
    } catch (const cv::Exception& e) {
      Napi::AsyncWorker::SetError(e.what());
    }
  }

  void OnOK() override {
    Napi::Env env = Env();

    // Profundidad
    std::string depth =
        (resultMat.depth() == CV_16U)                  ? "int16" :
        (resultMat.depth() == CV_32S || resultMat.depth() == CV_32F) ? "int32" :
                                                                      "int8";
    std::string chType = depth + "_" + channelOrder;

    // ── image { … } --------------------------------------------------------
    Napi::Object imageObj = Napi::Object::New(env);
    imageObj.Set("width",  Napi::Number::New(env, resultMat.cols));
    imageObj.Set("height", Napi::Number::New(env, resultMat.rows));
    imageObj.Set("channels", Napi::String::New(env, chType));

    size_t bytes = resultMat.total() * resultMat.elemSize();
    uint8_t* raw = new uint8_t[bytes];
    std::memcpy(raw, resultMat.data, bytes);

    auto dataBuf = Napi::Buffer<uint8_t>::New(
        env, raw, bytes,
        [](Napi::Env /*e*/, uint8_t* p) { delete[] p; });

    imageObj.Set("data", dataBuf);

    // ── timing { … } -------------------------------------------------------
    Napi::Object timingObj = Napi::Object::New(env);
    timingObj.Set("convertMs", Napi::Number::New(env, convertMs));
    timingObj.Set("taskMs",  Napi::Number::New(env, taskMs));

    // ── resultado final ----------------------------------------------------
    Napi::Object result = Napi::Object::New(env);
    result.Set("image",  imageObj);
    result.Set("timing", timingObj);

    Callback().Call({ env.Null(), result });
  }

  void OnError(const Napi::Error& e) override {
    Callback().Call({ e.Value(), Env().Null() });
  }

private:
  cv::Mat inputMat, resultMat;
  int     targetWidth, targetHeight;
  std::string channelOrder;

  double  convertMs = 0.0;
  double  taskMs  = 0.0;
};

Napi::Value Resize(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() != 4 || !info[3].IsFunction()) {
    Napi::TypeError::New(env,
      "Expected (ImageObject | ImageBuffer, width, height, callback)")
      .ThrowAsJavaScriptException();
    return env.Null();
  }

  Napi::Function cb = info[3].As<Napi::Function>();

  auto* worker = new ResizeWorker(
      cb,                         // ✅ ya no es r-value
      info[0],
      info[1].As<Napi::Number>().Int32Value(),
      info[2].As<Napi::Number>().Int32Value());

  worker->Queue();
  return env.Undefined();
}