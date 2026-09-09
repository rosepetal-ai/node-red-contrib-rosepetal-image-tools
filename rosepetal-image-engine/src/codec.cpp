// ───────── src/codec.cpp ───────────────────────────────────────────────
// Stand-alone decode / encode operations so the JS side never has to touch
// pixel data on the event loop:
//
//   decode(buffer, callback)
//     → { image: {data,width,height,channels,colorSpace,dtype}, timing }
//   encode(image, format, [quality], [pngOptimize], callback)
//     → { image: Buffer, timing }     format ∈ jpg | png | webp | bmp
//
// Both run entirely inside Napi::AsyncWorker::Execute() (libuv thread pool).
#include <napi.h>
#include <opencv2/opencv.hpp>
#include "utils.h"

/*------------------------------------------------------------------------*/
class DecodeWorker final : public Napi::AsyncWorker {
public:
  DecodeWorker(Napi::Function cb, const Napi::Value& input)
    : Napi::AsyncWorker(cb)
  {
    try {
      src_ = CaptureImage(input);
    } catch (const Napi::Error& e) {
      captureFailed_ = true; SetError(e.Message());
    } catch (const std::exception& e) {
      captureFailed_ = true; SetError(e.what());
    }
  }

protected:
  void Execute() override {
    if (captureFailed_) return;
    const int64 t0 = cv::getTickCount();
    src_.Materialize();                 // cv::imdecode on the worker thread
    result_ = src_.mat;
    colorSpace_ = src_.colorSpace;
    FinalizeForOutput(result_);         // own the memory before handing it to JS
    convertMs_ = (cv::getTickCount() - t0) / cv::getTickFrequency() * 1e3;
  }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::Object out = Napi::Object::New(env);
    out.Set("image", MatToRawJS(env, result_, colorSpace_));
    out.Set("timing", MakeTimingJS(env, convertMs_, 0.0, 0.0));
    Callback().Call({ env.Null(), out });
  }

  void OnError(const Napi::Error& e) override {
    Callback().Call({ e.Value(), Env().Null() });
  }

private:
  ImageSource src_;
  cv::Mat result_;
  std::string colorSpace_;
  bool captureFailed_ = false;
  double convertMs_ = 0.0;
};

/*------------------------------------------------------------------------*/
class EncodeWorker final : public Napi::AsyncWorker {
public:
  EncodeWorker(Napi::Function cb,
               const Napi::Value& input,
               std::string format,
               int quality,
               bool pngOptimize)
    : Napi::AsyncWorker(cb),
      format_(std::move(format)),
      quality_(quality),
      pngOptimize_(pngOptimize)
  {
    try {
      src_ = CaptureImage(input);
    } catch (const Napi::Error& e) {
      captureFailed_ = true; SetError(e.Message());
    } catch (const std::exception& e) {
      captureFailed_ = true; SetError(e.what());
    }
  }

protected:
  void Execute() override {
    if (captureFailed_) return;

    if (ParseImageFormat(format_) == ImageFormat::RAW) {
      throw std::runtime_error("encode(): unsupported format \"" + format_ +
                               "\" (expected jpg, png, webp or bmp)");
    }

    const int64 t0 = cv::getTickCount();
    src_.Materialize();
    convertMs_ = (cv::getTickCount() - t0) / cv::getTickFrequency() * 1e3;

    const cv::Mat prepared = PrepareForEncoding(src_.mat, src_.colorSpace, format_);
    encodeMs_ = EncodeToFormat(prepared, encoded_, format_, quality_, pngOptimize_);
  }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::Object out = Napi::Object::New(env);
    out.Set("image", VectorToBuffer(env, std::move(encoded_)));
    out.Set("timing", MakeTimingJS(env, convertMs_, 0.0, encodeMs_));
    Callback().Call({ env.Null(), out });
  }

  void OnError(const Napi::Error& e) override {
    Callback().Call({ e.Value(), Env().Null() });
  }

private:
  ImageSource src_;
  std::string format_;
  int quality_;
  bool pngOptimize_;
  bool captureFailed_ = false;
  std::vector<uchar> encoded_;
  double convertMs_ = 0.0, encodeMs_ = 0.0;
};

/*──────── binding: decode(buffer, callback) ─────────────────────────────*/
Napi::Value Decode(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[info.Length() - 1].IsFunction()) {
    Napi::TypeError::New(env, "decode(buffer, callback)").ThrowAsJavaScriptException();
    return env.Null();
  }
  (new DecodeWorker(info[info.Length() - 1].As<Napi::Function>(), info[0]))->Queue();
  return env.Undefined();
}

/*──────── binding: encode(image, format, [quality], [pngOptimize], callback) ─*/
Napi::Value Encode(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3 || info.Length() > 5 ||
      !info[1].IsString() || !info[info.Length() - 1].IsFunction()) {
    Napi::TypeError::New(env, "encode(image, format, [quality], [pngOptimize], callback)")
      .ThrowAsJavaScriptException();
    return env.Null();
  }

  std::string format = info[1].As<Napi::String>().Utf8Value();
  int quality = 90;
  bool pngOptimize = false;
  size_t i = 2;
  if (info.Length() - i >= 2 && info[i].IsNumber()) {
    quality = info[i++].As<Napi::Number>().Int32Value();
  }
  if (info.Length() - i >= 2 && info[i].IsBoolean()) {
    pngOptimize = info[i++].As<Napi::Boolean>().Value();
  }
  Napi::Function cb = info[info.Length() - 1].As<Napi::Function>();

  (new EncodeWorker(cb, info[0], format, quality, pngOptimize))->Queue();
  return env.Undefined();
}
