// ───────── src/filter.cpp (optimized kernel filtering) ─────────
#include <napi.h>
#include <opencv2/opencv.hpp>
#include "utils.h"
#include "filters/kernels.h"
#include <unordered_map>
#include <string>

/*------------------------------------------------------------------------*/
class FilterWorker final : public Napi::AsyncWorker {
public:
  FilterWorker(Napi::Function cb,
               const Napi::Value& imgVal,
               const std::string& filterType,
               int kernelSize,
               double intensity,
               std::string outputFormat,
               int quality = 90,
               bool pngOptimize = false)
    : Napi::AsyncWorker(cb),
      filterType_(filterType),
      kernelSize_(kernelSize),
      intensity_(intensity),
      outputFormat_(std::move(outputFormat)),
      quality_(quality),
      pngOptimize_(pngOptimize)
  {
    // Convert input image and measure timing
    const int64 t0 = cv::getTickCount();
    input_ = ConvertToMat(imgVal);
    convertMs_ = (cv::getTickCount() - t0) / cv::getTickFrequency() * 1e3;

    // Determine channel format
    if (imgVal.IsObject() && !imgVal.IsBuffer()) {
      Napi::Object obj = imgVal.As<Napi::Object>();
      
      // Check for colorSpace field
      if (obj.Has("colorSpace")) {
        channel_ = obj.Get("colorSpace").As<Napi::String>().Utf8Value();
      }
      // Default based on channel count
      else {
        channel_ = (input_.channels() == 4) ? "BGRA"
                 : (input_.channels() == 3) ? "BGR" 
                 : "GRAY";
      }
    } else {
      // Buffer input - determine from OpenCV Mat
      channel_ = (input_.channels() == 4) ? "BGRA"
               : (input_.channels() == 3) ? "BGR"
               : "GRAY";
    }
  }

protected:
  void Execute() override {
    const int64 t0 = cv::getTickCount();
    
    try {
      // Apply filter based on type
      if (filterType_ == "blur") {
        ApplyBlurFilter();
      } else if (filterType_ == "sharpen") {
        ApplySharpenFilter();
      } else if (filterType_ == "edge") {
        ApplyEdgeFilter();
      } else if (filterType_ == "emboss") {
        ApplyEmbossFilter();
      } else if (filterType_ == "gaussian") {
        ApplyGaussianFilter();
      } else {
        throw std::runtime_error("Unknown filter type: " + filterType_);
      }
      
      taskMs_ = (cv::getTickCount() - t0) / cv::getTickFrequency() * 1e3;
      
      // Multi-format encoding
      if (outputFormat_ != "raw") {
        const cv::Mat& srcForEncoding = (channel_ == "BGR") ? result_ 
                                       : ToBgrForJpg(result_, channel_);
        encodeMs_ = EncodeToFormat(srcForEncoding, encodedBuf_, outputFormat_, quality_, pngOptimize_);
      }
    } catch (const std::exception& e) {
      SetError(e.what());
    }
  }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::Value jsImg = (outputFormat_ != "raw")
        ? VectorToBuffer(env, std::move(encodedBuf_))
        : MatToRawJS(env, result_, channel_);

    Napi::Object out = Napi::Object::New(env);
    out.Set("image", jsImg);
    out.Set("timing", MakeTimingJS(env, convertMs_, taskMs_, encodeMs_));
    Callback().Call({ env.Null(), out });
  }

  void OnError(const Napi::Error& e) override {
    Callback().Call({ e.Value(), Env().Null() });
  }

private:
  cv::Mat input_, result_;
  std::string filterType_;
  int kernelSize_;
  double intensity_;
  std::string outputFormat_;
  int quality_;
  bool pngOptimize_;
  std::string channel_;
  
  double convertMs_{0.0}, taskMs_{0.0}, encodeMs_{0.0};
  std::vector<uchar> encodedBuf_;

  void ApplyBlurFilter() {
    // Box blur using OpenCV's optimized function
    cv::Size ksize(kernelSize_, kernelSize_);
    cv::boxFilter(input_, result_, -1, ksize);
    
    // Apply intensity (blend with original)
    if (intensity_ < 1.0) {
      cv::addWeighted(input_, 1.0 - intensity_, result_, intensity_, 0, result_);
    }
  }

  void ApplySharpenFilter() {
    // Create sharpening kernel
    cv::Mat kernel = CreateSharpenKernel(kernelSize_, intensity_);
    cv::filter2D(input_, result_, -1, kernel);
  }

  void ApplyEdgeFilter() {
    // Sobel edge detection
    cv::Mat grad_x, grad_y;
    cv::Mat gray;
    
    // Convert to grayscale for edge detection
    if (input_.channels() > 1) {
      cv::cvtColor(input_, gray, cv::COLOR_BGR2GRAY);
    } else {
      gray = input_;
    }
    
    // Apply Sobel
    cv::Sobel(gray, grad_x, CV_16S, 1, 0, kernelSize_);
    cv::Sobel(gray, grad_y, CV_16S, 0, 1, kernelSize_);
    
    // Calculate gradient magnitude
    cv::Mat abs_grad_x, abs_grad_y;
    cv::convertScaleAbs(grad_x, abs_grad_x);
    cv::convertScaleAbs(grad_y, abs_grad_y);
    
    cv::addWeighted(abs_grad_x, 0.5, abs_grad_y, 0.5, 0, result_);
    
    // Apply intensity
    cv::convertScaleAbs(result_, result_, intensity_);
    
    // Convert back to original channels if needed
    if (input_.channels() > 1) {
      cv::cvtColor(result_, result_, cv::COLOR_GRAY2BGR);
      if (input_.channels() == 4) {
        cv::cvtColor(result_, result_, cv::COLOR_BGR2BGRA);
      }
    }
  }

  void ApplyEmbossFilter() {
    // Create emboss kernel
    cv::Mat kernel = CreateEmbossKernel(intensity_);
    cv::filter2D(input_, result_, -1, kernel);
    
    // Add 128 to bring to mid-gray range for emboss effect
    result_ += cv::Scalar::all(128);
  }

  void ApplyGaussianFilter() {
    // Gaussian blur with OpenCV's optimized function
    cv::Size ksize(kernelSize_, kernelSize_);
    double sigma = kernelSize_ / 6.0 * intensity_; // Scale sigma with intensity
    cv::GaussianBlur(input_, result_, ksize, sigma);
  }
};

/*──────── binding: filter(image, filterType, kernelSize, intensity, [outputFormat], [quality], [pngOptimize], callback) ─*/
Napi::Value Filter(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  
  // Validate arguments
  if (info.Length() < 5 || info.Length() > 8 || !info[info.Length() - 1].IsFunction()) {
    return Napi::TypeError::New(env,
        "filter(image, filterType, kernelSize, intensity, [outputFormat], [quality], [pngOptimize], callback)").Value();
  }

  int i = 0;
  Napi::Value img = info[i++];
  std::string filterType = info[i++].As<Napi::String>();
  int kernelSize = info[i++].As<Napi::Number>().Int32Value();
  double intensity = info[i++].As<Napi::Number>().DoubleValue();
  
  // Handle parameters
  std::string outputFormat = "raw";
  int quality = 90;
  bool pngOptimize = false;
  
  if (info.Length() - i >= 2) {
    outputFormat = info[i++].As<Napi::String>().Utf8Value();
  }
  
  if (info.Length() - i >= 2) {
    quality = info[i++].As<Napi::Number>().Int32Value();
  }
  
  if (info.Length() - i >= 2) {
    pngOptimize = info[i++].As<Napi::Boolean>().Value();
  }
  
  Napi::Function cb = info[i].As<Napi::Function>();

  // Validate kernel size (must be odd)
  if (kernelSize % 2 == 0) {
    kernelSize++;
  }
  kernelSize = std::max(3, std::min(kernelSize, 15)); // Clamp to reasonable range

  // Create and queue worker
  (new FilterWorker(cb, img, filterType, kernelSize, intensity, outputFormat, quality, pngOptimize))->Queue();
  return env.Undefined();
}