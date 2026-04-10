#include <napi.h>
#include <opencv2/opencv.hpp>
#include "utils.h"

class HeatDiffWorker final : public Napi::AsyncWorker {
public:
  HeatDiffWorker(Napi::Function cb,
                 const Napi::Value& jsImg1,
                 const Napi::Value& jsImg2,
                 int colormapType,
                 int blurSize,
                 int threshold,
                 std::string outputFormat,
                 int quality = 90,
                 bool pngOptimize = false)
    : Napi::AsyncWorker(cb),
      colormapType(colormapType),
      blurSize(blurSize),
      threshold(threshold),
      outputFormat(std::move(outputFormat)),
      quality(quality),
      pngOptimize(pngOptimize)
  {
    const int64 t0 = cv::getTickCount();
    mat1 = ConvertToMat(jsImg1);
    mat2 = ConvertToMat(jsImg2);
    format1 = DetectChannelFormatShared(jsImg1, mat1);
    format2 = DetectChannelFormatShared(jsImg2, mat2);
    convertMs = (cv::getTickCount() - t0) / cv::getTickFrequency() * 1e3;
  }

protected:
  void Execute() override {
    const int64 t0 = cv::getTickCount();

    // Convert both to grayscale for diff computation
    cv::Mat gray1, gray2;

    if (mat1.channels() == 1) {
      gray1 = mat1;
    } else if (format1 == "BGR" || format1 == "BGRA") {
      cv::cvtColor(mat1, gray1, mat1.channels() == 4 ? cv::COLOR_BGRA2GRAY : cv::COLOR_BGR2GRAY);
    } else {
      cv::cvtColor(mat1, gray1, mat1.channels() == 4 ? cv::COLOR_RGBA2GRAY : cv::COLOR_RGB2GRAY);
    }

    if (mat2.channels() == 1) {
      gray2 = mat2;
    } else if (format2 == "BGR" || format2 == "BGRA") {
      cv::cvtColor(mat2, gray2, mat2.channels() == 4 ? cv::COLOR_BGRA2GRAY : cv::COLOR_BGR2GRAY);
    } else {
      cv::cvtColor(mat2, gray2, mat2.channels() == 4 ? cv::COLOR_RGBA2GRAY : cv::COLOR_RGB2GRAY);
    }

    // Resize if dimensions differ
    if (gray1.size() != gray2.size()) {
      cv::Size targetSize(std::max(gray1.cols, gray2.cols),
                          std::max(gray1.rows, gray2.rows));
      if (gray1.size() != targetSize) cv::resize(gray1, gray1, targetSize);
      if (gray2.size() != targetSize) cv::resize(gray2, gray2, targetSize);
    }

    // Absolute difference
    cv::Mat diff;
    cv::absdiff(gray1, gray2, diff);

    // Optional Gaussian blur to smooth noise
    if (blurSize > 0) {
      int ksize = blurSize | 1; // ensure odd
      cv::GaussianBlur(diff, diff, cv::Size(ksize, ksize), 0);
    }

    // Optional threshold to suppress small differences
    if (threshold > 0) {
      cv::threshold(diff, diff, threshold, 0, cv::THRESH_TOZERO);
    }

    // Apply colormap
    cv::applyColorMap(diff, result, colormapType);
    // applyColorMap outputs BGR
    outputChannel = "BGR";

    taskMs = (cv::getTickCount() - t0) / cv::getTickFrequency() * 1e3;

    if (outputFormat != "raw") {
      cv::Mat tmp = PrepareForEncoding(result, outputChannel, outputFormat);
      encodeMs = EncodeToFormat(tmp, encodedBuf, outputFormat, quality, pngOptimize);
    }
  }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::Value jsImg = (outputFormat != "raw")
      ? VectorToBuffer(env, std::move(encodedBuf))
      : MatToRawJS(env, result, outputChannel);

    Napi::Object out = Napi::Object::New(env);
    out.Set("image", jsImg);
    out.Set("timing", MakeTimingJS(env, convertMs, taskMs, encodeMs));
    Callback().Call({env.Null(), out});
  }

private:
  cv::Mat mat1, mat2, result;
  std::string format1, format2, outputChannel;
  int colormapType;
  int blurSize;
  int threshold;
  std::string outputFormat;
  int quality;
  bool pngOptimize;
  double convertMs = 0, taskMs = 0, encodeMs = 0;
  std::vector<uchar> encodedBuf;
};

Napi::Value HeatDiff(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 3 || !info[info.Length() - 1].IsFunction()) {
    Napi::TypeError::New(env,
      "heatDiff(image1, image2, colormapType, [blurSize], [threshold], [outputFormat], [quality], [pngOptimize], callback)")
      .ThrowAsJavaScriptException();
    return env.Null();
  }

  Napi::Value jsImg1 = info[0];
  Napi::Value jsImg2 = info[1];
  int colormapType = info[2].As<Napi::Number>().Int32Value();

  int blurSize = 0;
  int threshold = 0;
  std::string outputFormat = "raw";
  int quality = 90;
  bool pngOptimize = false;
  size_t cbIdx = 3;

  if (info.Length() >= 5) { blurSize = info[3].As<Napi::Number>().Int32Value(); cbIdx = 4; }
  if (info.Length() >= 6) { threshold = info[4].As<Napi::Number>().Int32Value(); cbIdx = 5; }
  if (info.Length() >= 7) { outputFormat = info[5].As<Napi::String>().Utf8Value(); cbIdx = 6; }
  if (info.Length() >= 8) { quality = info[6].As<Napi::Number>().Int32Value(); cbIdx = 7; }
  if (info.Length() >= 9) { pngOptimize = info[7].As<Napi::Boolean>().Value(); cbIdx = 8; }

  (new HeatDiffWorker(info[cbIdx].As<Napi::Function>(),
    jsImg1, jsImg2, colormapType, blurSize, threshold, outputFormat, quality, pngOptimize))->Queue();
  return env.Undefined();
}
