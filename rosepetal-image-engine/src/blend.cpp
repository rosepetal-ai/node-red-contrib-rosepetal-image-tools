#include <napi.h>
#include <opencv2/opencv.hpp>
#include "utils.h"


// Helper function to determine the best output channel format from two inputs
std::string DetermineOutputFormat(const std::string& format1, const std::string& format2) {
  // Priority: RGBA > BGRA > RGB > BGR > GRAY
  if (format1 == "RGBA" || format2 == "RGBA") return "RGBA";
  if (format1 == "BGRA" || format2 == "BGRA") return "BGRA";
  if (format1 == "RGB" || format2 == "RGB") return "RGB";
  if (format1 == "BGR" || format2 == "BGR") return "BGR";
  return "GRAY";
}


/*------------------------------------------------------------------------*/
class BlendWorker final : public Napi::AsyncWorker {
public:
  BlendWorker(Napi::Function cb,
              const Napi::Value& jsImg1,
              const Napi::Value& jsImg2,
              double opacity,
              std::string outputFormat,
              int quality = 90)
    : Napi::AsyncWorker(cb),
      opacity(opacity),
      outputFormat(std::move(outputFormat)),
      quality(quality)
  {
    // Timing and conversion
    const int64 t0 = cv::getTickCount();
    
    // Convert JavaScript inputs to OpenCV Mats
    mat1 = ConvertToMat(jsImg1);
    mat2 = ConvertToMat(jsImg2);
    
    // Detect channel formats
    format1 = DetectChannelFormatShared(jsImg1, mat1);
    format2 = DetectChannelFormatShared(jsImg2, mat2);
    
    // Determine output channel format
    outputChannel = DetermineOutputFormat(format1, format2);
    
    convertMs = (cv::getTickCount() - t0) / cv::getTickFrequency() * 1e3;
  }

protected:
  void Execute() override {
    const int64 t0 = cv::getTickCount();
    
    // Convert both images to the same target format
    cv::Mat img1 = ConvertToTargetFormatShared(mat1, format1, outputChannel);
    cv::Mat img2 = ConvertToTargetFormatShared(mat2, format2, outputChannel);
    
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
    
    // Blend the images using addWeighted
    // Formula: result = img1 * opacity + img2 * (1 - opacity)
    cv::addWeighted(img1, opacity, img2, 1.0 - opacity, 0.0, result);
    
    taskMs = (cv::getTickCount() - t0) / cv::getTickFrequency() * 1e3;

    // Multi-format encoding if needed
    if (outputFormat != "raw") {
      cv::Mat tmp = ToBgrForJpg(result, outputChannel);
      encodeMs = EncodeToFormat(tmp, encodedBuf, outputFormat, quality);
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
  double convertMs = 0, taskMs = 0, encodeMs = 0;
  std::vector<uchar> encodedBuf;
};

/*------------------------------------------------------------------------*/
Napi::Value Blend(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  
  // Fast parameter validation
  if (info.Length() < 4 || info.Length() > 6 || !info[info.Length() - 1].IsFunction()) {
    Napi::TypeError::New(env, "blend(image1, image2, opacity, [outputFormat], [quality], callback)")
      .ThrowAsJavaScriptException();
    return env.Null();
  }

  // Extract parameters
  Napi::Value jsImg1 = info[0];
  Napi::Value jsImg2 = info[1];
  double opacity = info[2].As<Napi::Number>().DoubleValue();
  
  // Clamp opacity to valid range [0.0, 1.0]
  opacity = std::max(0.0, std::min(1.0, opacity));
  
  // Handle optional parameters
  std::string outputFormat = "raw";
  int quality = 90;
  size_t cbIdx = 3;
  
  if (info.Length() >= 5) {
    outputFormat = info[3].As<Napi::String>().Utf8Value();
    cbIdx = 4;
  }
  
  if (info.Length() == 6) {
    quality = info[4].As<Napi::Number>().Int32Value();
    cbIdx = 5;
  }

  // Create and queue worker
  (new BlendWorker(info[cbIdx].As<Napi::Function>(), jsImg1, jsImg2, opacity, outputFormat, quality))->Queue();
  return env.Undefined();
}