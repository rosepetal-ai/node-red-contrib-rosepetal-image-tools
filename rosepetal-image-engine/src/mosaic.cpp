// ───────── src/mosaic.cpp ───────────────────────────────────────────────
// SUPER FAST mosaic node - Ultra-optimized image compositing
// Zero-copy operations, parallel processing, SIMD acceleration
#include <napi.h>
#include <opencv2/opencv.hpp>
#include <vector>
#include <algorithm>
#include <cmath>
#include "utils.h"

// Helper function to determine the best canvas format from multiple input formats
std::string DetermineBestCanvasFormat(const std::vector<std::string>& channels) {
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

/*────────────────────────── ULTRA-FAST MosaicWorker ───────────────────────────────────*/
class MosaicWorker : public Napi::AsyncWorker {
public:
  MosaicWorker(Napi::Function cb,
               const Napi::Array& imagesArray,
               int canvasWidth, int canvasHeight,
               const std::string& backgroundColor,
               const Napi::Array& positionsArray,
               bool normalized, std::string outputFormat,
               int quality = 90,
               bool pngOptimize = false)
    : Napi::AsyncWorker(cb),
      canvasWidth_(canvasWidth), canvasHeight_(canvasHeight),
      backgroundColor_(backgroundColor),
      normalized_(normalized), outputFormat_(std::move(outputFormat)),
      quality_(quality), pngOptimize_(pngOptimize)
  {
    /* ─ SUPER FAST image conversion with timing ─ */
    const int64 t0 = cv::getTickCount();
    
    // Pre-allocate vectors for maximum performance
    images_.reserve(imagesArray.Length());
    imageChannels_.reserve(imagesArray.Length());
    positions_.reserve(positionsArray.Length());
    
    // Convert images with zero-copy operations and extract channel formats
    for (uint32_t i = 0; i < imagesArray.Length(); i++) {
      images_.emplace_back(ConvertToMat(imagesArray[i]));
      
      // Extract and store channel format for each image (like other nodes do)
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
    
    // Parse positions - ultra-fast integer operations
    for (uint32_t i = 0; i < positionsArray.Length(); i++) {
      Napi::Object pos = positionsArray[i].As<Napi::Object>();
      Position p;
      p.arrayIndex = pos.Get("arrayIndex").As<Napi::Number>().Int32Value();
      p.x = pos.Get("x").As<Napi::Number>().DoubleValue();
      p.y = pos.Get("y").As<Napi::Number>().DoubleValue();
      positions_.emplace_back(p);
    }
    
    // Determine the best canvas format from all input images (priority: RGBA > BGRA > RGB > BGR > GRAY)
    canvasChannel_ = DetermineBestCanvasFormat(imageChannels_);
    
    convertMs_ = (cv::getTickCount() - t0) / cv::getTickFrequency() * 1e3;
  }

protected:
  void Execute() override {
    /* ─ SUPER FAST mosaic composition ─ */
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
    
    // Process all positions - PARALLEL when beneficial
    const size_t numPositions = positions_.size();
    
    if (numPositions > 4) {
      // Parallel processing for multiple positions
      #pragma omp parallel for
      for (int i = 0; i < static_cast<int>(numPositions); i++) {
        PlaceImageFast(positions_[i]);
      }
    } else {
      // Sequential processing for small batches (avoid threading overhead)
      for (const auto& pos : positions_) {
        PlaceImageFast(pos);
      }
    }
    
    taskMs_ = (cv::getTickCount() - t0) / cv::getTickFrequency() * 1e3;
    
    /* ─ SUPER FAST multi-format encoding (optional) ─ */
    if (outputFormat_ != "raw") {
      // Convert to BGR format for encoding if needed (like other nodes do)
      const cv::Mat& srcForEncoding = (canvasChannel_ == "BGR") ? canvas_ 
                                     : ToBgrForJpg(canvas_, canvasChannel_);
      encodeMs_ = EncodeToFormat(srcForEncoding, encodedBuf_, outputFormat_, quality_, pngOptimize_);
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
  struct Position {
    int arrayIndex;
    double x, y;
  };
  
  // ULTRA-FAST image placement with bounds checking
  void PlaceImageFast(const Position& pos) {
    if (pos.arrayIndex < 0 || pos.arrayIndex >= static_cast<int>(images_.size())) {
      return; // Skip invalid indices
    }
    
    const cv::Mat& img = images_[pos.arrayIndex];
    if (img.empty()) return;
    
    // Calculate position - FAST integer operations
    int x = normalized_ ? static_cast<int>(std::round(pos.x * canvasWidth_)) 
                        : static_cast<int>(std::lround(pos.x));
    int y = normalized_ ? static_cast<int>(std::round(pos.y * canvasHeight_)) 
                        : static_cast<int>(std::lround(pos.y));
    
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
    
    // Get the channel format for this specific image
    const std::string& imgChannel = imageChannels_[pos.arrayIndex];
    
    // Convert to canvas format based on actual input format (fixes blue color issue)
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
  std::vector<std::string> imageChannels_;  // Channel format for each image
  std::vector<Position> positions_;
  cv::Mat canvas_;
  std::string canvasChannel_;               // Output channel format
  
  int canvasWidth_, canvasHeight_;
  std::string backgroundColor_;
  bool normalized_;
  std::string outputFormat_;
  int quality_;
  bool pngOptimize_;
  
  double convertMs_{0.0}, taskMs_{0.0}, encodeMs_{0.0};
  std::vector<uchar> encodedBuf_;
};

/*──────── BINDING: mosaic(imagesArray, width, height, bgColor, positions, normalized, [outputFormat], [quality], [pngOptimize], cb) ─*/
Napi::Value Mosaic(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  
  // Ultra-fast parameter validation
  if (info.Length() < 7 || info.Length() > 10 || !info[info.Length()-1].IsFunction()) {
    return Napi::TypeError::New(env,
      "mosaic(imagesArray, width, height, bgColor, positions, normalized, [outputFormat], [quality], [pngOptimize], callback)")
      .Value();
  }
  
  // Parse parameters with minimal overhead
  int i = 0;
  Napi::Array imagesArray = info[i++].As<Napi::Array>();
  int canvasWidth = info[i++].As<Napi::Number>().Int32Value();
  int canvasHeight = info[i++].As<Napi::Number>().Int32Value();
  std::string backgroundColor = info[i++].As<Napi::String>().Utf8Value();
  Napi::Array positions = info[i++].As<Napi::Array>();
  bool normalized = info[i++].As<Napi::Boolean>().Value();
  
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
  
  Napi::Function callback = info[i].As<Napi::Function>();
  
  // Validate canvas dimensions
  if (canvasWidth <= 0 || canvasHeight <= 0) {
    return Napi::TypeError::New(env, "Canvas dimensions must be positive").Value();
  }
  
  // Launch ULTRA-FAST worker
  (new MosaicWorker(callback, imagesArray, canvasWidth, canvasHeight, 
                    backgroundColor, positions, normalized, outputFormat, quality, pngOptimize))->Queue();
  
  return env.Undefined();
}