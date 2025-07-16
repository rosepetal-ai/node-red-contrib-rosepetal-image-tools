#include <napi.h>
#include <opencv2/opencv.hpp>
#include "utils.h"
#include <unordered_map>

// Direction and strategy enums for faster comparisons
enum class Direction { RIGHT, LEFT, UP, DOWN };
enum class Strategy { RESIZE, PAD_START, PAD_END, PAD_BOTH };

/*------------------------------------------------------------------------*/
class ConcatWorker final : public Napi::AsyncWorker {
public:
  ConcatWorker(Napi::Function cb,
               const std::vector<Napi::Value>& jsImgs,
               std::string dir,
               std::string strat,
               cv::Scalar padRGB,
               bool jpg)
    : Napi::AsyncWorker(cb),
      padColorRGB(padRGB),
      encodeJpg(jpg)
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
    
    // Process first image to determine channel format
    if (imgCount > 0) {
      mats.emplace_back(ConvertToMat(jsImgs[0]));
      
      // Determine channel format once
      if (jsImgs[0].IsObject() && !jsImgs[0].IsBuffer()) {
        channel = ExtractChannelOrder(jsImgs[0].As<Napi::Object>()
                                    .Get("channels").As<Napi::String>());
      } else {
        const int channels = mats[0].channels();
        channel = (channels == 4) ? "BGRA" : (channels == 3) ? "BGR" : "GRAY";
      }
      
      // Process remaining images
      for (size_t i = 1; i < imgCount; ++i) {
        mats.emplace_back(ConvertToMat(jsImgs[i]));
      }
    }
    
    convertMs = (cv::getTickCount() - t0) / cv::getTickFrequency() * 1e3;

    // Prepare pad color - swap R and B if needed (do this once)
    padClrImg = padColorRGB;
    if (channel == "RGB" || channel == "RGBA") {
      std::swap(padClrImg[0], padClrImg[2]);
    }
    
    // Pre-calculate max dimensions to avoid redundant calculations
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
    
    for (auto& m : mats) {
      cv::Mat processed;
      
      // Directly handle resize case without branches
      if (strategy == Strategy::RESIZE) {
        if (isHorizontal) {
          double scale = static_cast<double>(baseSize) / m.rows;
          cv::resize(m, processed, cv::Size(static_cast<int>(m.cols * scale), baseSize));
        } else {
          double scale = static_cast<double>(baseSize) / m.cols;
          cv::resize(m, processed, cv::Size(baseSize, static_cast<int>(m.rows * scale)));
        }
      } else {
        // Handle padding cases
        const int delta = isHorizontal ? (baseSize - m.rows) : (baseSize - m.cols);
        if (delta <= 0) {
          processed = m; // No padding needed
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
            cv::copyMakeBorder(m, processed, before, after, 0, 0, cv::BORDER_CONSTANT, padClrImg);
          } else {
            cv::copyMakeBorder(m, processed, 0, 0, before, after, cv::BORDER_CONSTANT, padClrImg);
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

    // Fast JPG encoding if needed
    if (encodeJpg) {
      cv::Mat tmp = ToBgrForJpg(result, channel);
      encodeMs = EncodeToJpgFast(tmp, jpgBuf);
    }
  }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::Value jsImg = encodeJpg ? VectorToBuffer(env, std::move(jpgBuf))
                                  : MatToRawJS(env, result, channel);

    Napi::Object out = Napi::Object::New(env);
    out.Set("image", jsImg);
    out.Set("timing", MakeTimingJS(env, convertMs, taskMs, encodeMs));
    Callback().Call({env.Null(), out});
  }

private:
  std::vector<cv::Mat> mats;
  cv::Mat result;
  Direction direction;
  Strategy strategy;
  std::string channel;
  cv::Scalar padColorRGB, padClrImg;
  bool encodeJpg;
  double convertMs = 0, taskMs = 0, encodeMs = 0;
  std::vector<uchar> jpgBuf;
  int maxW = 0, maxH = 0;
};

/*------------------------------------------------------------------------*/
Napi::Value Concat(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  
  // Fast parameter validation
  if (info.Length() < 5 || !info[0].IsArray() || !info[1].IsString() ||
      !info[2].IsString() || !info[3].IsString() || !info[info.Length() - 1].IsFunction()) {
    Napi::TypeError::New(env, "concat(array, direction, strategy, padHex, [jpg], cb)")
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
  
  const bool jpg = (info.Length() == 6) ? info[4].As<Napi::Boolean>().Value() : false;
  const size_t cbIdx = (info.Length() == 6) ? 5 : 4;

  // Create and queue worker
  (new ConcatWorker(info[cbIdx].As<Napi::Function>(), raw, dir, st, pad, jpg))->Queue();
  return env.Undefined();
}