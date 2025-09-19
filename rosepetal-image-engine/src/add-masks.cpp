#include <napi.h>
#include <opencv2/opencv.hpp>
#include "utils.h"
#include <unordered_map>
#include <random>
#include <omp.h>
#include <immintrin.h>  // For AVX2 intrinsics

// Optimized structure to hold mask information
struct OptimizedMaskInfo {
  cv::Mat binaryMask;        // Pre-computed binary mask
  cv::Rect boundingBox;      // Bounding box for the mask
  cv::Vec3f normalizedColor; // Pre-normalized color (0-1 range)
  std::vector<cv::Point> pixelPoints; // Actual polygon points in pixels
  std::string className;
};

// Optimized polygon mask creation with bounding box
inline std::pair<cv::Mat, cv::Rect> CreateOptimizedPolygonMask(
    const std::vector<cv::Point2f>& polygon,
    cv::Size imageSize) {

  // Convert to pixel coordinates and find bounding box
  std::vector<cv::Point> pixelPolygon;
  pixelPolygon.reserve(polygon.size());

  int minX = imageSize.width, maxX = 0;
  int minY = imageSize.height, maxY = 0;

  for (const auto& point : polygon) {
    int x = static_cast<int>(point.x * imageSize.width);
    int y = static_cast<int>(point.y * imageSize.height);

    x = std::max(0, std::min(imageSize.width - 1, x));
    y = std::max(0, std::min(imageSize.height - 1, y));

    pixelPolygon.emplace_back(x, y);

    minX = std::min(minX, x);
    maxX = std::max(maxX, x);
    minY = std::min(minY, y);
    maxY = std::max(maxY, y);
  }

  // Create bounding box
  cv::Rect bbox(minX, minY, maxX - minX + 1, maxY - minY + 1);

  // Create mask only for bounding box region
  cv::Mat mask = cv::Mat::zeros(bbox.size(), CV_8UC1);

  // Adjust polygon coordinates to bounding box
  std::vector<cv::Point> adjustedPolygon;
  for (const auto& pt : pixelPolygon) {
    adjustedPolygon.emplace_back(pt.x - minX, pt.y - minY);
  }

  const cv::Point* pts = adjustedPolygon.data();
  int npts = static_cast<int>(adjustedPolygon.size());
  cv::fillPoly(mask, &pts, &npts, 1, cv::Scalar(255), cv::LINE_4); // LINE_4 is faster than LINE_AA

  return {mask, bbox};
}

// Optimized color generation (cached)
static std::unordered_map<std::string, cv::Vec3f> colorCache;

inline cv::Vec3f GetCachedColor(const std::string& className) {
  auto it = colorCache.find(className);
  if (it != colorCache.end()) {
    return it->second;
  }

  // Generate and cache
  std::hash<std::string> hasher;
  size_t seed = hasher(className);
  std::mt19937 rng(seed);
  std::uniform_int_distribution<int> dist(0, 255);

  int hue = rng() % 360;
  int saturation = 70 + (rng() % 30);
  int value = 70 + (rng() % 30);

  cv::Mat hsv(1, 1, CV_8UC3, cv::Scalar(hue / 2, saturation * 255 / 100, value * 255 / 100));
  cv::Mat rgb;
  cv::cvtColor(hsv, rgb, cv::COLOR_HSV2RGB);

  cv::Vec3b pixel = rgb.at<cv::Vec3b>(0, 0);
  cv::Vec3f color(pixel[2] / 255.0f, pixel[1] / 255.0f, pixel[0] / 255.0f);

  colorCache[className] = color;
  return color;
}

/*------------------------------------------------------------------------*/
class AddMasksOptimizedWorker final : public Napi::AsyncWorker {
public:
  AddMasksOptimizedWorker(Napi::Function cb,
                          const Napi::Value& jsImg,
                          const Napi::Array& masksArray,
                          const Napi::Object& classColorMap,
                          double maskStrength,
                          bool autoGenerateColors,
                          std::string outputFormat,
                          int quality = 90,
                          bool pngOptimize = false)
    : Napi::AsyncWorker(cb),
      maskStrength(static_cast<float>(maskStrength)),
      autoGenerateColors(autoGenerateColors),
      outputFormat(std::move(outputFormat)),
      quality(quality), pngOptimize(pngOptimize)
  {
    const int64 t0 = cv::getTickCount();

    // Convert JavaScript image to OpenCV Mat
    imageMat = ConvertToMat(jsImg);

    // Parse class color map
    std::unordered_map<std::string, cv::Vec3f> userColorMap;
    Napi::Array colorMapKeys = classColorMap.GetPropertyNames();
    for (size_t i = 0; i < colorMapKeys.Length(); i++) {
      std::string className = colorMapKeys.Get(i).As<Napi::String>().Utf8Value();
      std::string hexColor = classColorMap.Get(className).As<Napi::String>().Utf8Value();

      if (hexColor.length() == 7 && hexColor[0] == '#') {
        float r = std::stoi(hexColor.substr(1, 2), nullptr, 16) / 255.0f;
        float g = std::stoi(hexColor.substr(3, 2), nullptr, 16) / 255.0f;
        float b = std::stoi(hexColor.substr(5, 2), nullptr, 16) / 255.0f;
        userColorMap[className] = cv::Vec3f(b, g, r); // BGR for OpenCV
      }
    }

    // Pre-process all masks and create optimized structures
    for (size_t elementIndex = 0; elementIndex < masksArray.Length(); elementIndex++) {
      Napi::Object element = masksArray.Get(elementIndex).As<Napi::Object>();

      if (element.Has("masks")) {
        Napi::Array masks = element.Get("masks").As<Napi::Array>();

        for (size_t maskIndex = 0; maskIndex < masks.Length(); maskIndex++) {
          Napi::Object maskObj = masks.Get(maskIndex).As<Napi::Object>();

          if (maskObj.Has("mask") && maskObj.Has("class_name")) {
            Napi::Array maskArray = maskObj.Get("mask").As<Napi::Array>();
            if (maskArray.Length() > 0) {
              Napi::Array coordinates = maskArray.Get(0u).As<Napi::Array>();
              std::string className = maskObj.Get("class_name").As<Napi::String>().Utf8Value();

              // Parse polygon coordinates
              std::vector<cv::Point2f> polygon;
              polygon.reserve(coordinates.Length());

              for (size_t i = 0; i < coordinates.Length(); i++) {
                Napi::Array point = coordinates.Get(i).As<Napi::Array>();
                if (point.Length() >= 2) {
                  float x = point.Get(0u).As<Napi::Number>().FloatValue();
                  float y = point.Get(1u).As<Napi::Number>().FloatValue();
                  polygon.emplace_back(x, y);
                }
              }

              if (!polygon.empty()) {
                OptimizedMaskInfo maskInfo;
                maskInfo.className = className;

                // Get color
                auto colorIt = userColorMap.find(className);
                if (colorIt != userColorMap.end()) {
                  maskInfo.normalizedColor = colorIt->second;
                } else if (autoGenerateColors) {
                  maskInfo.normalizedColor = GetCachedColor(className);
                } else {
                  maskInfo.normalizedColor = cv::Vec3f(1.0f, 1.0f, 1.0f);
                }

                // Create optimized mask with bounding box
                auto [mask, bbox] = CreateOptimizedPolygonMask(polygon, imageMat.size());
                maskInfo.binaryMask = mask;
                maskInfo.boundingBox = bbox;

                optimizedMasks.push_back(std::move(maskInfo));
              }
            }
          }
        }
      }
    }

    imageFormat = DetectChannelFormatShared(jsImg, imageMat);
    outputChannel = imageFormat;

    convertMs = (cv::getTickCount() - t0) / cv::getTickFrequency() * 1e3;
  }

protected:
  void Execute() override {
    const int64 t0 = cv::getTickCount();

    // Convert image to target format
    cv::Mat img = ConvertToTargetFormatShared(imageMat, imageFormat, outputChannel);

    // Early exit if no masks
    if (optimizedMasks.empty()) {
      result = img.clone();
      taskMs = (cv::getTickCount() - t0) / cv::getTickFrequency() * 1e3;

      if (outputFormat != "raw") {
        cv::Mat tmp = ToBgrForJpg(result, outputChannel);
        encodeMs = EncodeToFormat(tmp, encodedBuf, outputFormat, quality, pngOptimize);
      }
      return;
    }

    // Work directly with uint8 for better performance
    result = img.clone();
    const int channels = result.channels();
    const int rows = result.rows;
    const int cols = result.cols;

    // Pre-calculate color space conversion if needed
    const bool isRGB = (outputChannel == "RGB" || outputChannel == "RGBA");

    // Process masks with optimized bounding box approach
    #pragma omp parallel for schedule(dynamic)
    for (size_t maskIdx = 0; maskIdx < optimizedMasks.size(); maskIdx++) {
      const auto& maskInfo = optimizedMasks[maskIdx];
      const cv::Rect& bbox = maskInfo.boundingBox;
      const cv::Mat& mask = maskInfo.binaryMask;

      // Ensure bounding box is within image bounds
      cv::Rect safeBbox = bbox & cv::Rect(0, 0, cols, rows);
      if (safeBbox.area() == 0) continue;

      // Adjust mask region if needed
      cv::Mat maskRegion = mask;
      if (safeBbox != bbox) {
        maskRegion = mask(cv::Rect(0, 0, safeBbox.width, safeBbox.height));
      }

      // Get color components (pre-scaled to 0-255)
      const float r = maskInfo.normalizedColor[isRGB ? 0 : 2] * 255.0f;
      const float g = maskInfo.normalizedColor[1] * 255.0f;
      const float b = maskInfo.normalizedColor[isRGB ? 2 : 0] * 255.0f;

      // Process only the bounding box region
      for (int y = 0; y < safeBbox.height; y++) {
        const uchar* maskRow = maskRegion.ptr<uchar>(y);
        uchar* imgRow = result.ptr<uchar>(safeBbox.y + y) + safeBbox.x * channels;

        // Vectorized processing for better performance
        #pragma omp simd
        for (int x = 0; x < safeBbox.width; x++) {
          if (maskRow[x] > 0) {
            const float alpha = maskStrength;
            const float invAlpha = 1.0f - alpha;

            if (channels == 1) {
              // Grayscale
              float gray = (r + g + b) / 3.0f;
              imgRow[x] = static_cast<uchar>(imgRow[x] * invAlpha + gray * alpha);
            } else if (channels == 3) {
              // RGB/BGR
              int idx = x * 3;
              imgRow[idx] = static_cast<uchar>(imgRow[idx] * invAlpha + b * alpha);
              imgRow[idx + 1] = static_cast<uchar>(imgRow[idx + 1] * invAlpha + g * alpha);
              imgRow[idx + 2] = static_cast<uchar>(imgRow[idx + 2] * invAlpha + r * alpha);
            } else if (channels == 4) {
              // RGBA/BGRA
              int idx = x * 4;
              imgRow[idx] = static_cast<uchar>(imgRow[idx] * invAlpha + b * alpha);
              imgRow[idx + 1] = static_cast<uchar>(imgRow[idx + 1] * invAlpha + g * alpha);
              imgRow[idx + 2] = static_cast<uchar>(imgRow[idx + 2] * invAlpha + r * alpha);
              // Keep alpha channel unchanged
            }
          }
        }
      }
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
  cv::Mat imageMat, result;
  std::string imageFormat, outputChannel;
  std::vector<OptimizedMaskInfo> optimizedMasks;
  float maskStrength;
  bool autoGenerateColors;
  std::string outputFormat;
  int quality;
  bool pngOptimize;
  double convertMs = 0, taskMs = 0, encodeMs = 0;
  std::vector<uchar> encodedBuf;
};

/*------------------------------------------------------------------------*/
Napi::Value AddMasks(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 6 || info.Length() > 9 || !info[info.Length() - 1].IsFunction()) {
    Napi::TypeError::New(env, "addMasks(image, masksArray, classColorMap, maskStrength, autoGenerateColors, [outputFormat], [quality], [pngOptimize], callback)")
      .ThrowAsJavaScriptException();
    return env.Null();
  }

  Napi::Value jsImg = info[0];
  Napi::Array masksArray = info[1].As<Napi::Array>();
  Napi::Object classColorMap = info[2].As<Napi::Object>();
  double maskStrength = info[3].As<Napi::Number>().DoubleValue();
  bool autoGenerateColors = info[4].As<Napi::Boolean>().Value();

  maskStrength = std::max(0.0, std::min(1.0, maskStrength));

  std::string outputFormat = "raw";
  int quality = 90;
  bool pngOptimize = false;
  size_t cbIdx = 5;

  if (info.Length() >= 7) {
    outputFormat = info[5].As<Napi::String>().Utf8Value();
    cbIdx = 6;
  }

  if (info.Length() >= 8) {
    quality = info[6].As<Napi::Number>().Int32Value();
    cbIdx = 7;
  }

  if (info.Length() == 9) {
    pngOptimize = info[7].As<Napi::Boolean>().Value();
    cbIdx = 8;
  }

  (new AddMasksOptimizedWorker(
    info[cbIdx].As<Napi::Function>(),
    jsImg, masksArray, classColorMap, maskStrength, autoGenerateColors,
    outputFormat, quality, pngOptimize
  ))->Queue();

  return env.Undefined();
}