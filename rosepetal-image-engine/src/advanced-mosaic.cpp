// ───────── src/advanced-mosaic.cpp ───────────────────────────────────────────────
// ADVANCED MOSAIC - Ultra-optimized image compositing with per-image transformations
// Combines resize, rotate, and positioning in a single high-performance pipeline
#include <napi.h>
#include <opencv2/opencv.hpp>
#include <vector>
#include <algorithm>
#include <cmath>
#include "utils.h"

// Helper function to determine the best canvas format from multiple input formats
std::string DetermineBestCanvasFormatAdvanced(const std::vector<std::string>& channels) {
  if (channels.empty()) return "BGR";
  
  bool hasRGBA = false, hasBGRA = false, hasRGB = false, hasBGR = false;
  
  for (const auto& ch : channels) {
    if (ch == "RGBA") hasRGBA = true;
    else if (ch == "BGRA") hasBGRA = true;
    else if (ch == "RGB") hasRGB = true;
    else if (ch == "BGR") hasBGR = true;
  }
  
  // Priority: RGBA > BGRA > RGB > BGR > GRAY
  if (hasRGBA) return "RGBA";
  if (hasBGRA) return "BGRA";
  if (hasRGB) return "RGB";
  if (hasBGR) return "BGR";
  return "GRAY";
}

/*────────────────────────── ULTRA-FAST AdvancedMosaicWorker ───────────────────────────────────*/
class AdvancedMosaicWorker : public Napi::AsyncWorker {
public:
  AdvancedMosaicWorker(Napi::Function cb,
                       const Napi::Array& imagesArray,
                       int canvasWidth, int canvasHeight,
                       const std::string& backgroundColor,
                       const Napi::Array& imageConfigsArray,
                       bool normalized, std::string outputFormat,
                       int quality = 90)
    : Napi::AsyncWorker(cb),
      canvasWidth_(canvasWidth), canvasHeight_(canvasHeight),
      backgroundColor_(backgroundColor),
      normalized_(normalized), outputFormat_(std::move(outputFormat)),
      quality_(quality)
  {
    /* ─ SUPER FAST image conversion with timing ─ */
    const int64 t0 = cv::getTickCount();
    
    // Pre-allocate vectors for maximum performance
    images_.reserve(imagesArray.Length());
    imageChannels_.reserve(imagesArray.Length());
    imageConfigs_.reserve(imageConfigsArray.Length());
    
    // Convert images with zero-copy operations and extract channel formats
    for (uint32_t i = 0; i < imagesArray.Length(); i++) {
      images_.emplace_back(ConvertToMat(imagesArray[i]));
      
      // Extract and store channel format for each image
      std::string channel;
      if (imagesArray[i].IsObject() && !imagesArray[i].IsBuffer()) {
        Napi::Object obj = imagesArray[i].As<Napi::Object>();
        
        // Check for new colorSpace field first
        if (obj.Has("colorSpace")) {
          channel = obj.Get("colorSpace").As<Napi::String>().Utf8Value();
        }
        // Default based on channel count
        else {
          channel = (images_[i].channels() == 4) ? "BGRA"
                  : (images_[i].channels() == 3) ? "BGR" 
                  : "GRAY";
        }
      } else {
        // Buffer input - determine from OpenCV Mat
        channel = (images_[i].channels() == 4) ? "BGRA"
                : (images_[i].channels() == 3) ? "BGR"
                : "GRAY";
      }
      
      imageChannels_.emplace_back(channel);
    }
    
    // Parse image configurations - ultra-fast operations
    for (uint32_t i = 0; i < imageConfigsArray.Length(); i++) {
      Napi::Object config = imageConfigsArray[i].As<Napi::Object>();
      ImageConfig imgConfig;
      
      imgConfig.arrayIndex = config.Get("arrayIndex").As<Napi::Number>().Int32Value();
      imgConfig.x = config.Get("x").As<Napi::Number>().DoubleValue();
      imgConfig.y = config.Get("y").As<Napi::Number>().DoubleValue();
      imgConfig.rotation = config.Get("rotation").As<Napi::Number>().DoubleValue();
      imgConfig.zIndex = config.Has("zIndex") ? config.Get("zIndex").As<Napi::Number>().Int32Value() : i;
      
      // Handle optional width/height (null means keep original)
      if (config.Has("width") && !config.Get("width").IsNull()) {
        imgConfig.width = config.Get("width").As<Napi::Number>().Int32Value();
      } else {
        imgConfig.width = -1; // Keep original
      }
      
      if (config.Has("height") && !config.Get("height").IsNull()) {
        imgConfig.height = config.Get("height").As<Napi::Number>().Int32Value();
      } else {
        imgConfig.height = -1; // Keep original
      }
      
      imageConfigs_.emplace_back(imgConfig);
    }
    
    // Sort by zIndex for proper layering
    std::sort(imageConfigs_.begin(), imageConfigs_.end(),
              [](const ImageConfig& a, const ImageConfig& b) {
                return a.zIndex < b.zIndex;
              });
    
    // Determine the best canvas format from all input images
    canvasChannel_ = DetermineBestCanvasFormatAdvanced(imageChannels_);
    
    convertMs_ = (cv::getTickCount() - t0) / cv::getTickFrequency() * 1e3;
  }

protected:
  void Execute() override {
    /* ─ SUPER FAST advanced mosaic composition ─ */
    const int64 t0 = cv::getTickCount();
    
    // Parse background color - optimized hex parsing (returns BGR format)
    cv::Scalar bgColor = ParseColor(backgroundColor_, cv::Scalar(0, 0, 0));
    
    // Fix color inversion: ParseColor returns BGR, but we need to handle different canvas formats
    if (canvasChannel_ == "RGB" || canvasChannel_ == "RGBA") {
      // For RGB format canvas, swap B and R channels from BGR to RGB
      std::swap(bgColor[0], bgColor[2]); // Swap Blue and Red
    }
    
    // Create canvas with correct format based on output channel format
    int canvasType = CV_8UC3;  // Default to 3 channels (BGR)
    if (canvasChannel_ == "BGRA" || canvasChannel_ == "RGBA") {
      canvasType = CV_8UC4;
      bgColor = cv::Scalar(bgColor[0], bgColor[1], bgColor[2], 255); // Add alpha channel
    } else if (canvasChannel_ == "GRAY") {
      canvasType = CV_8UC1;
      bgColor = cv::Scalar((bgColor[0] + bgColor[1] + bgColor[2]) / 3.0); // Convert to grayscale
    }
    
    canvas_ = cv::Mat(canvasHeight_, canvasWidth_, canvasType, bgColor);
    
    // Process all image configurations in Z-order
    for (const auto& config : imageConfigs_) {
      ProcessImageFast(config);
    }
    
    taskMs_ = (cv::getTickCount() - t0) / cv::getTickFrequency() * 1e3;
    
    /* ─ SUPER FAST multi-format encoding (optional) ─ */
    if (outputFormat_ != "raw") {
      // Convert to BGR format for encoding if needed
      const cv::Mat& srcForEncoding = (canvasChannel_ == "BGR") ? canvas_ 
                                     : ToBgrForJpg(canvas_, canvasChannel_);
      encodeMs_ = EncodeToFormat(srcForEncoding, encodedBuf_, outputFormat_, quality_);
    }
  }
  
  void OnOK() override {
    Napi::Env env = Env();
    
    // Zero-copy output creation with correct channel format
    Napi::Value jsImg = (outputFormat_ != "raw")
        ? VectorToBuffer(env, std::move(encodedBuf_))       // Zero-copy encoded
        : MatToRawJS(env, canvas_.clone(), canvasChannel_); // Contiguous raw with correct channel format
    
    Napi::Object result = Napi::Object::New(env);
    result.Set("image", jsImg);
    result.Set("timing", MakeTimingJS(env, convertMs_, taskMs_, encodeMs_));
    
    Callback().Call({ env.Null(), result });
  }
  
  void OnError(const Napi::Error& e) override {
    Callback().Call({ e.Value(), Env().Null() });
  }

private:
  struct ImageConfig {
    int arrayIndex;
    double x, y;
    double rotation;
    int width, height;  // -1 means keep original
    int zIndex;
  };
  
  // ULTRA-FAST image processing with transformations
  void ProcessImageFast(const ImageConfig& config) {
    if (config.arrayIndex < 0 || config.arrayIndex >= static_cast<int>(images_.size())) {
      return; // Skip invalid indices
    }
    
    cv::Mat img = images_[config.arrayIndex].clone(); // Work with copy for transformations
    if (img.empty()) return;
    
    const std::string& imgChannel = imageChannels_[config.arrayIndex];
    
    // Step 1: Resize if needed
    if (config.width > 0 || config.height > 0) {
      int targetWidth = config.width > 0 ? config.width : img.cols;
      int targetHeight = config.height > 0 ? config.height : img.rows;
      
      // Maintain aspect ratio if only one dimension specified
      if (config.width > 0 && config.height <= 0) {
        targetHeight = static_cast<int>(std::round(targetWidth * static_cast<double>(img.rows) / img.cols));
      } else if (config.height > 0 && config.width <= 0) {
        targetWidth = static_cast<int>(std::round(targetHeight * static_cast<double>(img.cols) / img.rows));
      }
      
      cv::resize(img, img, cv::Size(targetWidth, targetHeight), 0, 0, cv::INTER_LINEAR);
    }
    
    // Step 2: Rotate if needed
    if (std::abs(config.rotation) > 1e-3) {
      // Fast-path for 90-degree rotations
      double normalizedAngle = std::fmod(config.rotation + 360.0, 360.0);
      double eps = 1e-3;
      
      if (std::abs(normalizedAngle) < eps || std::abs(normalizedAngle - 360.0) < eps) {
        // 0 degrees - no rotation needed
      } else if (std::abs(normalizedAngle - 90.0) < eps) {
        // 90° counterclockwise (mathematical standard)
        cv::rotate(img, img, cv::ROTATE_90_COUNTERCLOCKWISE);
      } else if (std::abs(normalizedAngle - 180.0) < eps) {
        cv::rotate(img, img, cv::ROTATE_180);
      } else if (std::abs(normalizedAngle - 270.0) < eps) {
        // 270° counterclockwise = 90° clockwise
        cv::rotate(img, img, cv::ROTATE_90_CLOCKWISE);
      } else {
        // Arbitrary angles - use affine transformation
        // Negate rotation to make positive angles counterclockwise (mathematical standard)
        // OpenCV uses clockwise positive, so we negate to get counterclockwise positive
        int w = img.cols, h = img.rows;
        cv::Point2f center(w / 2.0f, h / 2.0f);
        cv::Mat rotationMatrix = cv::getRotationMatrix2D(center, -config.rotation, 1.0);
        
        // Calculate new bounding box to prevent cropping
        double cosA = std::abs(rotationMatrix.at<double>(0, 0));
        double sinA = std::abs(rotationMatrix.at<double>(0, 1));
        cv::Size newSize(static_cast<int>(h * sinA + w * cosA), 
                        static_cast<int>(h * cosA + w * sinA));
        
        // Adjust translation to center the rotated image
        rotationMatrix.at<double>(0, 2) += newSize.width / 2.0 - center.x;
        rotationMatrix.at<double>(1, 2) += newSize.height / 2.0 - center.y;
        
        // Parse background color for rotation padding
        cv::Scalar padColor = ParseColor(backgroundColor_, cv::Scalar(0, 0, 0));
        if (imgChannel == "RGB" || imgChannel == "RGBA") {
          std::swap(padColor[0], padColor[2]); // Convert RGB to BGR
        }
        
        cv::warpAffine(img, img, rotationMatrix, newSize, 
                      cv::INTER_LINEAR, cv::BORDER_CONSTANT, padColor);
      }
    }
    
    // Step 3: Place on canvas
    PlaceImageOnCanvas(img, config, imgChannel);
  }
  
  // ULTRA-FAST image placement with bounds checking
  void PlaceImageOnCanvas(const cv::Mat& img, const ImageConfig& config, const std::string& imgChannel) {
    if (img.empty()) return;
    
    // Calculate position - FAST integer operations
    int x = normalized_ ? static_cast<int>(std::round(config.x * canvasWidth_)) 
                        : static_cast<int>(std::lround(config.x));
    int y = normalized_ ? static_cast<int>(std::round(config.y * canvasHeight_)) 
                        : static_cast<int>(std::lround(config.y));
    
    // FAST bounds checking with early exit
    if (x >= canvasWidth_ || y >= canvasHeight_) return;
    if (x + img.cols <= 0 || y + img.rows <= 0) return;
    
    // Calculate intersection rectangle - OPTIMIZED
    int srcX = std::max(0, -x);
    int srcY = std::max(0, -y);
    int dstX = std::max(0, x);
    int dstY = std::max(0, y);
    
    int width = std::min(img.cols - srcX, canvasWidth_ - dstX);
    int height = std::min(img.rows - srcY, canvasHeight_ - dstY);
    
    if (width <= 0 || height <= 0) return;
    
    // ZERO-COPY image placement using OpenCV's optimized copyTo
    cv::Rect srcROI(srcX, srcY, width, height);
    cv::Rect dstROI(dstX, dstY, width, height);
    
    // Convert input image to match canvas format
    cv::Mat imgToPlace;
    cv::Mat srcRegion = img(srcROI);
    
    // Convert input image to match canvas format
    if (canvasChannel_ == "GRAY") {
      // Convert to grayscale canvas
      if (imgChannel == "GRAY") {
        imgToPlace = srcRegion;
      } else if (imgChannel == "RGB") {
        cv::cvtColor(srcRegion, imgToPlace, cv::COLOR_RGB2GRAY);
      } else if (imgChannel == "RGBA") {
        cv::cvtColor(srcRegion, imgToPlace, cv::COLOR_RGBA2GRAY);
      } else if (imgChannel == "BGRA") {
        cv::cvtColor(srcRegion, imgToPlace, cv::COLOR_BGRA2GRAY);
      } else {
        cv::cvtColor(srcRegion, imgToPlace, cv::COLOR_BGR2GRAY);
      }
    } else if (canvasChannel_ == "BGR") {
      // Convert to BGR canvas
      if (imgChannel == "GRAY") {
        cv::cvtColor(srcRegion, imgToPlace, cv::COLOR_GRAY2BGR);
      } else if (imgChannel == "RGB") {
        cv::cvtColor(srcRegion, imgToPlace, cv::COLOR_RGB2BGR);
      } else if (imgChannel == "RGBA") {
        cv::cvtColor(srcRegion, imgToPlace, cv::COLOR_RGBA2BGR);
      } else if (imgChannel == "BGRA") {
        cv::cvtColor(srcRegion, imgToPlace, cv::COLOR_BGRA2BGR);
      } else {
        imgToPlace = srcRegion; // Already BGR
      }
    } else if (canvasChannel_ == "RGB") {
      // Convert to RGB canvas
      if (imgChannel == "GRAY") {
        cv::cvtColor(srcRegion, imgToPlace, cv::COLOR_GRAY2RGB);
      } else if (imgChannel == "RGB") {
        imgToPlace = srcRegion; // Already RGB
      } else if (imgChannel == "RGBA") {
        cv::cvtColor(srcRegion, imgToPlace, cv::COLOR_RGBA2RGB);
      } else if (imgChannel == "BGRA") {
        cv::cvtColor(srcRegion, imgToPlace, cv::COLOR_BGRA2RGB);
      } else {
        cv::cvtColor(srcRegion, imgToPlace, cv::COLOR_BGR2RGB);
      }
    } else if (canvasChannel_ == "BGRA") {
      // Convert to BGRA canvas
      if (imgChannel == "GRAY") {
        cv::cvtColor(srcRegion, imgToPlace, cv::COLOR_GRAY2BGRA);
      } else if (imgChannel == "RGB") {
        cv::cvtColor(srcRegion, imgToPlace, cv::COLOR_RGB2BGRA);
      } else if (imgChannel == "RGBA") {
        cv::cvtColor(srcRegion, imgToPlace, cv::COLOR_RGBA2BGRA);
      } else if (imgChannel == "BGRA") {
        imgToPlace = srcRegion; // Already BGRA
      } else {
        cv::cvtColor(srcRegion, imgToPlace, cv::COLOR_BGR2BGRA);
      }
    } else if (canvasChannel_ == "RGBA") {
      // Convert to RGBA canvas
      if (imgChannel == "GRAY") {
        cv::cvtColor(srcRegion, imgToPlace, cv::COLOR_GRAY2RGBA);
      } else if (imgChannel == "RGB") {
        cv::cvtColor(srcRegion, imgToPlace, cv::COLOR_RGB2RGBA);
      } else if (imgChannel == "RGBA") {
        imgToPlace = srcRegion; // Already RGBA
      } else if (imgChannel == "BGRA") {
        cv::cvtColor(srcRegion, imgToPlace, cv::COLOR_BGRA2RGBA);
      } else {
        cv::cvtColor(srcRegion, imgToPlace, cv::COLOR_BGR2RGBA);
      }
    } else {
      // Default to BGR conversion
      if (imgChannel == "GRAY") {
        cv::cvtColor(srcRegion, imgToPlace, cv::COLOR_GRAY2BGR);
      } else if (imgChannel == "RGB") {
        cv::cvtColor(srcRegion, imgToPlace, cv::COLOR_RGB2BGR);
      } else if (imgChannel == "RGBA") {
        cv::cvtColor(srcRegion, imgToPlace, cv::COLOR_RGBA2BGR);
      } else if (imgChannel == "BGRA") {
        cv::cvtColor(srcRegion, imgToPlace, cv::COLOR_BGRA2BGR);
      } else {
        imgToPlace = srcRegion;
      }
    }
    
    // FASTEST copy operation - zero-copy when possible
    imgToPlace.copyTo(canvas_(dstROI));
  }
  
  // Member variables
  std::vector<cv::Mat> images_;
  std::vector<std::string> imageChannels_;
  std::vector<ImageConfig> imageConfigs_;
  cv::Mat canvas_;
  std::string canvasChannel_;
  
  int canvasWidth_, canvasHeight_;
  std::string backgroundColor_;
  bool normalized_;
  std::string outputFormat_;
  int quality_;
  
  double convertMs_{0.0}, taskMs_{0.0}, encodeMs_{0.0};
  std::vector<uchar> encodedBuf_;
};

/*──────── BINDING: advancedMosaic(imagesArray, width, height, bgColor, imageConfigs, normalized, [outputFormat], [quality], cb) ─*/
Napi::Value AdvancedMosaic(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  
  // Ultra-fast parameter validation
  if (info.Length() < 7 || info.Length() > 9 || !info[info.Length()-1].IsFunction()) {
    return Napi::TypeError::New(env,
      "advancedMosaic(imagesArray, width, height, bgColor, imageConfigs, normalized, [outputFormat], [quality], callback)")
      .Value();
  }
  
  // Parse parameters with minimal overhead
  int i = 0;
  Napi::Array imagesArray = info[i++].As<Napi::Array>();
  int canvasWidth = info[i++].As<Napi::Number>().Int32Value();
  int canvasHeight = info[i++].As<Napi::Number>().Int32Value();
  std::string backgroundColor = info[i++].As<Napi::String>().Utf8Value();
  Napi::Array imageConfigs = info[i++].As<Napi::Array>();
  bool normalized = info[i++].As<Napi::Boolean>().Value();
  
  // Handle optional parameters
  std::string outputFormat = "raw";
  int quality = 90;
  
  if (info.Length() - i >= 2) {
    outputFormat = info[i++].As<Napi::String>().Utf8Value();
  }
  
  if (info.Length() - i >= 2) {
    quality = info[i++].As<Napi::Number>().Int32Value();
  }
  
  Napi::Function callback = info[i].As<Napi::Function>();
  
  // Validate canvas dimensions
  if (canvasWidth <= 0 || canvasHeight <= 0) {
    return Napi::TypeError::New(env, "Canvas dimensions must be positive").Value();
  }
  
  // Launch ULTRA-FAST worker
  (new AdvancedMosaicWorker(callback, imagesArray, canvasWidth, canvasHeight, 
                           backgroundColor, imageConfigs, normalized, outputFormat, quality))->Queue();
  
  return env.Undefined();
}