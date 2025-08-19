#include <napi.h>
#include <opencv2/opencv.hpp>
#include "utils.h"




/*------------------------------------------------------------------------*/
class BlendWorker final : public Napi::AsyncWorker {
public:
  BlendWorker(Napi::Function cb,
              const Napi::Value& jsImg1,
              const Napi::Value& jsImg2,
              double opacity,
              std::string outputFormat,
              int quality = 90,
              bool pngOptimize = false,
              bool alphaCompositing = false,
              bool removeBackground = false,
              std::string backgroundColor = "#ffffff",
              double colorTolerance = 0.1)
    : Napi::AsyncWorker(cb),
      opacity(opacity),
      outputFormat(std::move(outputFormat)),
      quality(quality), pngOptimize(pngOptimize),
      alphaCompositing(alphaCompositing),
      removeBackground(removeBackground),
      backgroundColor(std::move(backgroundColor)),
      colorTolerance(colorTolerance)
  {
    // Timing and conversion
    const int64 t0 = cv::getTickCount();
    
    // Convert JavaScript inputs to OpenCV Mats
    mat1 = ConvertToMat(jsImg1);
    mat2 = ConvertToMat(jsImg2);
    
    // Detect channel formats
    format1 = DetectChannelFormatShared(jsImg1, mat1);
    format2 = DetectChannelFormatShared(jsImg2, mat2);
    
    // Determine output channel format - force BGRA for alpha compositing
    if (alphaCompositing) {
      outputChannel = "BGRA";
    } else {
      outputChannel = DetermineOutputFormat(format1, format2);
    }
    
    convertMs = (cv::getTickCount() - t0) / cv::getTickFrequency() * 1e3;
  }

protected:
  void Execute() override {
    const int64 t0 = cv::getTickCount();
    
    // Convert both images to the same target format
    cv::Mat img1 = ConvertToTargetFormatShared(mat1, format1, outputChannel);
    cv::Mat img2 = ConvertToTargetFormatShared(mat2, format2, outputChannel);
    
    // Apply background removal to image2 if requested
    if (alphaCompositing && removeBackground) {
      cv::Scalar bgColor = parseColorString(backgroundColor);
      img2 = removeColorBackground(img2, bgColor, colorTolerance);
      // Update img2 to BGRA format after background removal
      if (img2.channels() != 4) {
        cv::cvtColor(img2, img2, cv::COLOR_BGR2BGRA);
      }
    }
    
    // Ensure both images have the same dimensions (resize smaller to match larger)
    cv::Size targetSize;
    if (img1.size() != img2.size()) {
      // Use the larger dimensions
      targetSize.width = std::max(img1.cols, img2.cols);
      targetSize.height = std::max(img1.rows, img2.rows);
      
      if (img1.size() != targetSize) {
        cv::resize(img1, img1, targetSize);
      }
      if (img2.size() != targetSize) {
        cv::resize(img2, img2, targetSize);
      }
    }
    
    // Choose blending algorithm based on mode
    if (alphaCompositing) {
      // Use proper alpha compositing: img1 as base, img2 as overlay
      result = alphaComposite(img1, img2, opacity);
    } else {
      // Use traditional addWeighted blending
      // Formula: result = img1 * opacity + img2 * (1 - opacity)
      cv::addWeighted(img1, opacity, img2, 1.0 - opacity, 0.0, result);
    }
    
    taskMs = (cv::getTickCount() - t0) / cv::getTickFrequency() * 1e3;

    // Multi-format encoding if needed
    if (outputFormat != "raw") {
      cv::Mat tmp = ToBgrForJpg(result, outputChannel);
      encodeMs = EncodeToFormat(tmp, encodedBuf, outputFormat, quality, pngOptimize);
    }
  }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::Value jsImg = (outputFormat != "raw") ? VectorToBuffer(env, std::move(encodedBuf))
                                                : MatToRawJS(env, result, outputChannel);

    Napi::Object out = Napi::Object::New(env);
    out.Set("image", jsImg);
    out.Set("timing", MakeTimingJS(env, convertMs, taskMs, encodeMs));
    Callback().Call({env.Null(), out});
  }

private:
  cv::Mat mat1, mat2, result;
  std::string format1, format2, outputChannel;
  double opacity;
  std::string outputFormat;
  int quality;
  bool pngOptimize;
  bool alphaCompositing;
  bool removeBackground;
  std::string backgroundColor;
  double colorTolerance;
  double convertMs = 0, taskMs = 0, encodeMs = 0;
  std::vector<uchar> encodedBuf;
};

/*------------------------------------------------------------------------*/
Napi::Value Blend(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  
  // Fast parameter validation - now supports up to 11 parameters
  if (info.Length() < 4 || info.Length() > 11 || !info[info.Length() - 1].IsFunction()) {
    Napi::TypeError::New(env, "blend(image1, image2, opacity, [outputFormat], [quality], [pngOptimize], [alphaCompositing], [removeBackground], [backgroundColor], [colorTolerance], callback)")
      .ThrowAsJavaScriptException();
    return env.Null();
  }

  // Extract required parameters
  Napi::Value jsImg1 = info[0];
  Napi::Value jsImg2 = info[1];
  double opacity = info[2].As<Napi::Number>().DoubleValue();
  
  // Clamp opacity to valid range [0.0, 1.0]
  opacity = std::max(0.0, std::min(1.0, opacity));
  
  // Handle optional parameters
  std::string outputFormat = "raw";
  int quality = 90;
  bool pngOptimize = false;
  bool alphaCompositing = false;
  bool removeBackground = false;
  std::string backgroundColor = "#ffffff";
  double colorTolerance = 0.1;
  size_t cbIdx = 3;
  
  if (info.Length() >= 5) {
    outputFormat = info[3].As<Napi::String>().Utf8Value();
    cbIdx = 4;
  }
  
  if (info.Length() >= 6) {
    quality = info[4].As<Napi::Number>().Int32Value();
    cbIdx = 5;
  }
  
  if (info.Length() >= 7) {
    pngOptimize = info[5].As<Napi::Boolean>().Value();
    cbIdx = 6;
  }
  
  if (info.Length() >= 8) {
    alphaCompositing = info[6].As<Napi::Boolean>().Value();
    cbIdx = 7;
  }
  
  if (info.Length() >= 9) {
    removeBackground = info[7].As<Napi::Boolean>().Value();
    cbIdx = 8;
  }
  
  if (info.Length() >= 10) {
    backgroundColor = info[8].As<Napi::String>().Utf8Value();
    cbIdx = 9;
  }
  
  if (info.Length() == 11) {
    colorTolerance = info[9].As<Napi::Number>().DoubleValue();
    // Clamp tolerance to valid range [0.0, 1.0]
    colorTolerance = std::max(0.0, std::min(1.0, colorTolerance));
    cbIdx = 10;
  }

  // Create and queue worker
  (new BlendWorker(info[cbIdx].As<Napi::Function>(), jsImg1, jsImg2, opacity, outputFormat, quality, pngOptimize,
                   alphaCompositing, removeBackground, backgroundColor, colorTolerance))->Queue();
  return env.Undefined();
}