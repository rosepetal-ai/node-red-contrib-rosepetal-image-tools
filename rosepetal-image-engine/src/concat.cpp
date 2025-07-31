#include <napi.h>
#include <opencv2/opencv.hpp>
#include "utils.h"
#include <unordered_map>

// Direction and strategy enums for faster comparisons
enum class Direction { RIGHT, LEFT, UP, DOWN };
enum class Strategy { RESIZE, PAD_START, PAD_END, PAD_BOTH };

// Helper function to detect channel format for individual images
std::string DetectChannelFormat(const Napi::Value& jsImg, const cv::Mat& mat) {
  if (jsImg.IsObject() && !jsImg.IsBuffer()) {
    Napi::Object obj = jsImg.As<Napi::Object>();
    
    // Check for new colorSpace field first
    if (obj.Has("colorSpace")) {
      return obj.Get("colorSpace").As<Napi::String>().Utf8Value();
    }
    // Default based on channel count
    else {
      const int channels = mat.channels();
      return (channels == 4) ? "BGRA" : (channels == 3) ? "BGR" : "GRAY";
    }
  } else {
    // Buffer input - determine from OpenCV Mat
    const int channels = mat.channels();
    return (channels == 4) ? "BGRA" : (channels == 3) ? "BGR" : "GRAY";
  }
}

// Helper function to determine the best output channel format from a list
std::string DetermineOutputFormat(const std::vector<std::string>& channels) {
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

// Helper function to prepare pad color for specific channel format
cv::Scalar PreparePadColor(const cv::Scalar& originalColor, const std::string& channelFormat) {
  cv::Scalar padColor = originalColor;
  if (channelFormat == "RGB" || channelFormat == "RGBA") {
    std::swap(padColor[0], padColor[2]); // Swap R and B
  }
  return padColor;
}

// Helper function to convert image to target channel format
cv::Mat ConvertToTargetFormat(const cv::Mat& src, const std::string& srcFormat, const std::string& targetFormat) {
  if (srcFormat == targetFormat) {
    return src; // No conversion needed
  }
  
  cv::Mat dst;
  
  // Convert to target format
  if (srcFormat == "GRAY" && targetFormat == "BGR") {
    cv::cvtColor(src, dst, cv::COLOR_GRAY2BGR);
  } else if (srcFormat == "GRAY" && targetFormat == "RGB") {
    cv::cvtColor(src, dst, cv::COLOR_GRAY2RGB);
  } else if (srcFormat == "GRAY" && targetFormat == "BGRA") {
    cv::cvtColor(src, dst, cv::COLOR_GRAY2BGRA);
  } else if (srcFormat == "GRAY" && targetFormat == "RGBA") {
    cv::cvtColor(src, dst, cv::COLOR_GRAY2RGBA);
  } else if (srcFormat == "BGR" && targetFormat == "RGB") {
    cv::cvtColor(src, dst, cv::COLOR_BGR2RGB);
  } else if (srcFormat == "RGB" && targetFormat == "BGR") {
    cv::cvtColor(src, dst, cv::COLOR_RGB2BGR);
  } else if (srcFormat == "BGR" && targetFormat == "BGRA") {
    cv::cvtColor(src, dst, cv::COLOR_BGR2BGRA);
  } else if (srcFormat == "BGR" && targetFormat == "RGBA") {
    cv::cvtColor(src, dst, cv::COLOR_BGR2RGBA);
  } else if (srcFormat == "RGB" && targetFormat == "RGBA") {
    cv::cvtColor(src, dst, cv::COLOR_RGB2RGBA);
  } else if (srcFormat == "RGB" && targetFormat == "BGRA") {
    cv::cvtColor(src, dst, cv::COLOR_RGB2BGRA);
  } else if (srcFormat == "BGRA" && targetFormat == "BGR") {
    cv::cvtColor(src, dst, cv::COLOR_BGRA2BGR);
  } else if (srcFormat == "RGBA" && targetFormat == "RGB") {
    cv::cvtColor(src, dst, cv::COLOR_RGBA2RGB);
  } else if (srcFormat == "BGRA" && targetFormat == "RGBA") {
    cv::cvtColor(src, dst, cv::COLOR_BGRA2RGBA);
  } else if (srcFormat == "RGBA" && targetFormat == "BGRA") {
    cv::cvtColor(src, dst, cv::COLOR_RGBA2BGRA);
  } else {
    // Fallback: return source if no conversion available
    dst = src;
  }
  
  return dst;
}

/*------------------------------------------------------------------------*/
class ConcatWorker final : public Napi::AsyncWorker {
public:
  ConcatWorker(Napi::Function cb,
               const std::vector<Napi::Value>& jsImgs,
               std::string dir,
               std::string strat,
               cv::Scalar padRGB,
               std::string outputFormat,
               int quality = 90)
    : Napi::AsyncWorker(cb),
      padColorRGB(padRGB),
      outputFormat(std::move(outputFormat)),
      quality(quality)
  {
    // Convert string enums to faster integer types
    if (dir == "right") direction = Direction::RIGHT;
    else if (dir == "left") direction = Direction::LEFT;
    else if (dir == "up") direction = Direction::UP;
    else direction = Direction::DOWN;

    if (strat.find("resize") != std::string::npos) strategy = Strategy::RESIZE;
    else if (strat == "pad-start") strategy = Strategy::PAD_START;
    else if (strat == "pad-end") strategy = Strategy::PAD_END;
    else strategy = Strategy::PAD_BOTH;

    // Timing and conversion
    const int64 t0 = cv::getTickCount();
    const size_t imgCount = jsImgs.size();
    mats.reserve(imgCount);
    channels.reserve(imgCount);
    
    // Process all images and detect their channel formats
    for (size_t i = 0; i < imgCount; ++i) {
      mats.emplace_back(ConvertToMat(jsImgs[i]));
      channels.push_back(DetectChannelFormat(jsImgs[i], mats[i]));
    }
    
    // Determine output channel format
    outputChannel = DetermineOutputFormat(channels);
    
    convertMs = (cv::getTickCount() - t0) / cv::getTickFrequency() * 1e3;

    // Store original pad color (channel-specific preparation will be done per image)
    padClrImg = padColorRGB;
    
    // Pre-calculate max dimensions after channel format detection
    // (dimensions shouldn't change with channel conversion)
    for (const auto& m : mats) {
      maxW = std::max(maxW, m.cols);
      maxH = std::max(maxH, m.rows);
    }
  }

protected:
  void Execute() override {
    const int64 t0 = cv::getTickCount();
    
    const bool isHorizontal = (direction == Direction::RIGHT || direction == Direction::LEFT);
    const int baseSize = isHorizontal ? maxH : maxW;
    
    // Prepare tiles with optimized preprocessing
    std::vector<cv::Mat> tiles;
    tiles.reserve(mats.size());
    
    for (size_t i = 0; i < mats.size(); ++i) {
      auto& m = mats[i];
      const std::string& imgChannel = channels[i];
      
      // Convert image to target output format first
      cv::Mat convertedMat = ConvertToTargetFormat(m, imgChannel, outputChannel);
      cv::Mat processed;
      
      // Debug: log the converted image properties
      // std::cout << "Image " << i << ": " << imgChannel << " -> " << outputChannel
      //           << " size: " << convertedMat.cols << "x" << convertedMat.rows 
      //           << " channels: " << convertedMat.channels() << " type: " << convertedMat.type() << std::endl;
      
      // Prepare pad color for the target output format
      cv::Scalar imgPadColor = PreparePadColor(padColorRGB, outputChannel);
      
      // Directly handle resize case without branches
      if (strategy == Strategy::RESIZE) {
        if (isHorizontal) {
          double scale = static_cast<double>(baseSize) / convertedMat.rows;
          cv::resize(convertedMat, processed, cv::Size(static_cast<int>(convertedMat.cols * scale), baseSize));
        } else {
          double scale = static_cast<double>(baseSize) / convertedMat.cols;
          cv::resize(convertedMat, processed, cv::Size(baseSize, static_cast<int>(convertedMat.rows * scale)));
        }
      } else {
        // Handle padding cases
        const int delta = isHorizontal ? (baseSize - convertedMat.rows) : (baseSize - convertedMat.cols);
        if (delta <= 0) {
          processed = convertedMat; // No padding needed
        } else {
          int before = 0, after = 0;
          
          switch (strategy) {
            case Strategy::PAD_START:
              before = delta;
              break;
            case Strategy::PAD_END:
              after = delta;
              break;
            case Strategy::PAD_BOTH:
              before = delta / 2;
              after = delta - before;
              break;
            default: break;
          }
          
          if (isHorizontal) {
            cv::copyMakeBorder(convertedMat, processed, before, after, 0, 0, cv::BORDER_CONSTANT, imgPadColor);
          } else {
            cv::copyMakeBorder(convertedMat, processed, 0, 0, before, after, cv::BORDER_CONSTANT, imgPadColor);
          }
        }
      }
      
      tiles.push_back(std::move(processed));
    }

    // Perform concatenation based on direction
    if (isHorizontal) {
      cv::hconcat(tiles, result);
      if (direction == Direction::LEFT) {
        cv::flip(result, result, 1);
      }
    } else {
      if (direction == Direction::UP) {
        std::reverse(tiles.begin(), tiles.end());
      }
      cv::vconcat(tiles, result);
    }

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
  std::vector<cv::Mat> mats;
  std::vector<std::string> channels;
  cv::Mat result;
  Direction direction;
  Strategy strategy;
  std::string outputChannel;
  cv::Scalar padColorRGB, padClrImg;
  std::string outputFormat;
  int quality;
  double convertMs = 0, taskMs = 0, encodeMs = 0;
  std::vector<uchar> encodedBuf;
  int maxW = 0, maxH = 0;
};

/*------------------------------------------------------------------------*/
Napi::Value Concat(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  
  // Fast parameter validation
  if (info.Length() < 5 || info.Length() > 7 || !info[0].IsArray() || !info[1].IsString() ||
      !info[2].IsString() || !info[3].IsString() || !info[info.Length() - 1].IsFunction()) {
    Napi::TypeError::New(env, "concat(array, direction, strategy, padHex, [outputFormat], [quality], cb)")
      .ThrowAsJavaScriptException();
    return env.Null();
  }

  // Process input array efficiently
  auto arr = info[0].As<Napi::Array>();
  const uint32_t len = arr.Length();
  std::vector<Napi::Value> raw;
  raw.reserve(len);
  
  for (uint32_t i = 0; i < len; ++i) {
    raw.push_back(arr.Get(i));
  }

  // Extract other parameters
  std::string dir = info[1].As<Napi::String>();
  std::string st = info[2].As<Napi::String>();
  cv::Scalar pad = ParseColor(info[3].As<Napi::String>());
  
  // Handle parameters
  std::string outputFormat = "raw";
  int quality = 90;
  size_t cbIdx = 4;
  
  if (info.Length() >= 6) {
    outputFormat = info[4].As<Napi::String>().Utf8Value();
    cbIdx = 5;
  }
  
  if (info.Length() == 7) {
    quality = info[5].As<Napi::Number>().Int32Value();
    cbIdx = 6;
  }

  // Create and queue worker
  (new ConcatWorker(info[cbIdx].As<Napi::Function>(), raw, dir, st, pad, outputFormat, quality))->Queue();
  return env.Undefined();
}