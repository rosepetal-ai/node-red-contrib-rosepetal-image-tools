#include <napi.h>
#include <opencv2/opencv.hpp>
#include "utils.h"
#include <unordered_map>
#include <random>
#include <cmath>
#include <algorithm>
// OpenMP is only used via pragmas; header is not required unless functions are called.
// We avoid including it to keep macOS builds (without libomp headers) happy.
// #include <omp.h>

#if defined(__x86_64__) || defined(_M_X64) || defined(__i386__) || defined(_M_IX86)
#include <immintrin.h>  // AVX2 intrinsics (not used on non-x86 builds)
#endif

// Optimized structure to hold mask information
struct OptimizedMaskInfo {
  cv::Mat binaryMask;        // Pre-computed binary mask
  cv::Rect boundingBox;      // Bounding box for the mask
  cv::Vec3f normalizedColor; // Pre-normalized color (0-1 range)
  std::vector<cv::Point> pixelPoints; // Actual polygon points in pixels
  std::string className;
  int priority;              // Priority for overlap resolution (lower = higher priority)
  int originalIndex;         // Original input order for tie-breaking
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

// Resolve class name from common field names
inline std::string ExtractClassName(const Napi::Object& obj) {
  const std::vector<std::string> keys = {"tag", "class_name", "className", "label", "class"};
  for (const auto& key : keys) {
    if (obj.Has(key) && obj.Get(key).IsString()) {
      std::string value = obj.Get(key).As<Napi::String>().Utf8Value();
      if (!value.empty()) return value;
    }
  }
  return "";
}

inline cv::Mat BuildMaskFrom2DArray(const Napi::Array& rows) {
  const uint32_t rowCount = rows.Length();
  if (rowCount == 0) return cv::Mat();

  int cols = -1;
  for (uint32_t y = 0; y < rowCount; y++) {
    if (rows.Get(y).IsArray()) {
      cols = static_cast<int>(rows.Get(y).As<Napi::Array>().Length());
      if (cols > 0) break;
    }
  }
  if (cols <= 0) return cv::Mat();

  cv::Mat mask(rowCount, cols, CV_8UC1, cv::Scalar(0));
  for (uint32_t y = 0; y < rowCount; y++) {
    if (!rows.Get(y).IsArray()) continue;
    Napi::Array row = rows.Get(y).As<Napi::Array>();
    const uint32_t rowLen = row.Length();
    for (uint32_t x = 0; x < rowLen && x < static_cast<uint32_t>(cols); x++) {
      if (row.Get(x).IsNumber()) {
        double v = row.Get(x).As<Napi::Number>().DoubleValue();
        if (std::isfinite(v) && v != 0.0) {
          double scaled = v > 1.0 ? v : v * 255.0;
          mask.at<uchar>(y, x) = static_cast<uchar>(std::clamp(scaled, 0.0, 255.0));
        }
      }
    }
  }
  return mask;
}

// Handles either a 2D mask matrix or an array of matrices (uses the first valid one)
inline cv::Mat ConvertMaskArrayToMat(const Napi::Array& arr) {
  if (arr.Length() == 0) return cv::Mat();

  Napi::Value first = arr.Get(0u);
  if (first.IsArray()) {
    Napi::Array firstArr = first.As<Napi::Array>();
    if (firstArr.Length() > 0 && firstArr.Get(0u).IsArray()) {
      // Array of masks -> pick the first valid one
      for (uint32_t i = 0; i < arr.Length(); i++) {
        if (!arr.Get(i).IsArray()) continue;
        cv::Mat candidate = BuildMaskFrom2DArray(arr.Get(i).As<Napi::Array>());
        if (!candidate.empty()) return candidate;
      }
      return cv::Mat();
    }
  }

  return BuildMaskFrom2DArray(arr);
}

inline cv::Mat ConvertMaskImageToMat(const Napi::Value& maskVal, const cv::Size& targetSize) {
  try {
    cv::Mat maskMat = ConvertToMat(maskVal);
    if (maskMat.empty()) return cv::Mat();

    cv::Mat singleChannel;
    if (maskMat.channels() == 4) {
      cv::extractChannel(maskMat, singleChannel, 3); // Prefer alpha channel
    } else if (maskMat.channels() == 3) {
      cv::cvtColor(maskMat, singleChannel, cv::COLOR_BGR2GRAY);
    } else {
      singleChannel = maskMat;
    }

    if (singleChannel.depth() != CV_8U) {
      cv::Mat tmp;
      singleChannel.convertTo(tmp, CV_8U, 255.0);
      singleChannel = tmp;
    }

    cv::Mat binary;
    cv::threshold(singleChannel, binary, 0, 255, cv::THRESH_BINARY);

    if (binary.size() != targetSize) {
      cv::resize(binary, binary, targetSize, 0, 0, cv::INTER_NEAREST);
    }

    return binary;
  } catch (const Napi::Error&) {
    return cv::Mat();
  } catch (...) {
    return cv::Mat();
  }
}

inline cv::Mat NormalizeMaskBinary(cv::Mat mask, const cv::Size& targetSize) {
  if (mask.empty()) return mask;

  if (mask.channels() > 1) {
    cv::Mat gray;
    cv::cvtColor(mask, gray, cv::COLOR_BGR2GRAY);
    mask = gray;
  }

  if (mask.depth() != CV_8U) {
    cv::Mat tmp;
    mask.convertTo(tmp, CV_8U, 255.0);
    mask = tmp;
  }

  cv::Mat binary;
  cv::threshold(mask, binary, 0, 255, cv::THRESH_BINARY);

  if (binary.size() != targetSize) {
    cv::resize(binary, binary, targetSize, 0, 0, cv::INTER_NEAREST);
  }

  return binary;
}

// Generate maximally different color from existing colors
inline cv::Vec3f GenerateMaximallyDifferentColor(
    const std::string& className,
    const std::unordered_map<std::string, cv::Vec3f>& userColors) {

  // Collect all used colors
  std::vector<cv::Vec3f> usedColors;
  for (const auto& [_, color] : userColors) {
    usedColors.push_back(color);
  }
  for (const auto& [_, color] : colorCache) {
    usedColors.push_back(color);
  }

  // If no existing colors, start with a vivid red
  if (usedColors.empty()) {
    cv::Vec3f firstColor(0.0f, 0.0f, 1.0f); // BGR: pure red
    colorCache[className] = firstColor;
    return firstColor;
  }

  // Generate candidate colors evenly distributed in HSV space
  std::vector<cv::Vec3f> candidates;
  const int numHues = 24; // Every 15 degrees
  const int numSaturations = 3; // 60%, 80%, 100%
  const int numValues = 3; // 60%, 80%, 100%

  for (int h = 0; h < numHues; h++) {
    for (int s = 0; s < numSaturations; s++) {
      for (int v = 0; v < numValues; v++) {
        float hue = (h * 360.0f / numHues);
        float saturation = 0.6f + s * 0.2f; // 60%, 80%, 100%
        float value = 0.6f + v * 0.2f; // 60%, 80%, 100%

        // Convert HSV to BGR
        cv::Mat hsv(1, 1, CV_32FC3, cv::Scalar(hue / 360.0f, saturation, value));
        cv::Mat bgr;
        cv::cvtColor(hsv, bgr, cv::COLOR_HSV2BGR);

        cv::Vec3f color = bgr.at<cv::Vec3f>(0, 0);
        candidates.push_back(color);
      }
    }
  }

  // Find candidate with maximum minimum distance to existing colors
  float maxMinDistance = 0;
  cv::Vec3f bestColor = candidates[0];

  for (const auto& candidate : candidates) {
    float minDistance = std::numeric_limits<float>::max();

    for (const auto& existing : usedColors) {
      // Calculate perceptual color distance with weighted components
      // Human eye is more sensitive to green, then red, then blue
      float dist = sqrt(
        pow((candidate[2] - existing[2]) * 2.0f, 2) + // Red (BGR[2])
        pow((candidate[1] - existing[1]) * 3.0f, 2) + // Green (BGR[1])
        pow((candidate[0] - existing[0]) * 1.0f, 2)   // Blue (BGR[0])
      );
      minDistance = std::min(minDistance, dist);
    }

    if (minDistance > maxMinDistance) {
      maxMinDistance = minDistance;
      bestColor = candidate;
    }
  }

  // Cache and return
  colorCache[className] = bestColor;
  return bestColor;
}

inline cv::Vec3f GetCachedColor(const std::string& className) {
  auto it = colorCache.find(className);
  if (it != colorCache.end()) {
    return it->second;
  }

  // This should not be called anymore, but keep as fallback
  cv::Vec3f color(1.0f, 1.0f, 1.0f); // White fallback
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
                          const Napi::Array& classPriorityOrder,
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

    // Build priority map from ordered array (lower index = higher priority)
    std::unordered_map<std::string, int> priorityMap;
    for (size_t i = 0; i < classPriorityOrder.Length(); i++) {
      if (classPriorityOrder.Get(i).IsString()) {
        std::string cls = classPriorityOrder.Get(i).As<Napi::String>().Utf8Value();
        priorityMap[cls] = static_cast<int>(i);
      }
    }

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

    auto resolveColor = [&](const std::string& className) -> cv::Vec3f {
      auto colorIt = userColorMap.find(className);
      if (colorIt != userColorMap.end()) {
        return colorIt->second;
      }

      auto cachedColorIt = colorCache.find(className);
      if (cachedColorIt != colorCache.end()) {
        return cachedColorIt->second;
      }

      if (autoGenerateColors) {
        return GenerateMaximallyDifferentColor(className, userColorMap);
      }

      return cv::Vec3f(1.0f, 1.0f, 1.0f);
    };

    // Lambda to resolve priority for a class name
    auto resolvePriority = [&](const std::string& className, int originalIndex) -> int {
      auto it = priorityMap.find(className);
      if (it != priorityMap.end()) {
        return it->second;  // Mapped class: use priority from order
      }
      // Unmapped class: use INT_MAX base + original index for tie-breaking
      return INT_MAX / 2 + originalIndex;
    };

    // Pre-process all masks and create optimized structures
    for (size_t maskIndex = 0; maskIndex < masksArray.Length(); maskIndex++) {
      if (!masksArray.Get(maskIndex).IsObject()) continue;
      Napi::Object maskObj = masksArray.Get(maskIndex).As<Napi::Object>();

      std::string className = ExtractClassName(maskObj);
      if (className.empty()) continue;

      cv::Vec3f resolvedColor = resolveColor(className);
      bool addedPolygon = false;

      // --- Polygons path (preferred when present) ---
      if (maskObj.Has("polygons") && maskObj.Get("polygons").IsArray()) {
        Napi::Array polygonsArray = maskObj.Get("polygons").As<Napi::Array>();
        for (size_t polyIdx = 0; polyIdx < polygonsArray.Length(); polyIdx++) {
          if (!polygonsArray.Get(polyIdx).IsArray()) {
            continue;
          }

          Napi::Array coordinates = polygonsArray.Get(polyIdx).As<Napi::Array>();

          // Parse polygon coordinates
          std::vector<cv::Point2f> polygon;
          polygon.reserve(coordinates.Length());

          for (size_t i = 0; i < coordinates.Length(); i++) {
            if (!coordinates.Get(i).IsArray()) {
              continue;
            }
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
            maskInfo.normalizedColor = resolvedColor;
            maskInfo.priority = resolvePriority(className, static_cast<int>(maskIndex));
            maskInfo.originalIndex = static_cast<int>(maskIndex);

            // Create optimized mask with bounding box
            auto [mask, bbox] = CreateOptimizedPolygonMask(polygon, imageMat.size());
            maskInfo.binaryMask = mask;
            maskInfo.boundingBox = bbox;

            optimizedMasks.push_back(std::move(maskInfo));
            addedPolygon = true;
          }
        }
      }

      // --- Raw mask path (inferencer 'mask' output) ---
      if (!addedPolygon && maskObj.Has("mask")) {
        cv::Mat maskBinary;
        Napi::Value maskVal = maskObj.Get("mask");

        if (maskVal.IsArray()) {
          maskBinary = ConvertMaskArrayToMat(maskVal.As<Napi::Array>());
        } else if (maskVal.IsBuffer() || maskVal.IsObject()) {
          maskBinary = ConvertMaskImageToMat(maskVal, imageMat.size());
        }

        maskBinary = NormalizeMaskBinary(maskBinary, imageMat.size());

        if (!maskBinary.empty()) {
          std::vector<cv::Point> nonZeroPts;
          cv::findNonZero(maskBinary, nonZeroPts);
          if (!nonZeroPts.empty()) {
            cv::Rect bbox = cv::boundingRect(nonZeroPts);
            OptimizedMaskInfo maskInfo;
            maskInfo.className = className;
            maskInfo.normalizedColor = resolvedColor;
            maskInfo.priority = resolvePriority(className, static_cast<int>(maskIndex));
            maskInfo.originalIndex = static_cast<int>(maskIndex);
            maskInfo.boundingBox = bbox;
            maskInfo.binaryMask = maskBinary(bbox).clone();
            optimizedMasks.push_back(std::move(maskInfo));
          }
        }
      }
    }

    // Sort masks by priority (lower priority value = higher precedence)
    // Use stable_sort to preserve original order for equal priorities
    std::stable_sort(optimizedMasks.begin(), optimizedMasks.end(),
      [](const OptimizedMaskInfo& a, const OptimizedMaskInfo& b) {
        if (a.priority != b.priority) return a.priority < b.priority;
        return a.originalIndex < b.originalIndex;  // Tie-breaker: input order
      });

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
        cv::Mat tmp = PrepareForEncoding(result, outputChannel, outputFormat);
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

    // Create painted-pixel tracking matrix (single channel, same size as image)
    // Used to ensure each pixel is only painted once by the highest-priority mask
    cv::Mat painted = cv::Mat::zeros(rows, cols, CV_8UC1);

    // Process masks SEQUENTIALLY to respect priority order
    // Masks are already sorted by priority (lower value = higher priority)
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
      const float cr = maskInfo.normalizedColor[isRGB ? 0 : 2] * 255.0f;
      const float cg = maskInfo.normalizedColor[1] * 255.0f;
      const float cb = maskInfo.normalizedColor[isRGB ? 2 : 0] * 255.0f;

      // Process only the bounding box region
      for (int y = 0; y < safeBbox.height; y++) {
        const int globalY = safeBbox.y + y;
        const uchar* maskRow = maskRegion.ptr<uchar>(y);
        uchar* paintedRow = painted.ptr<uchar>(globalY);
        uchar* imgRow = result.ptr<uchar>(globalY);

        for (int x = 0; x < safeBbox.width; x++) {
          const int globalX = safeBbox.x + x;

          // Skip if already painted by higher-priority mask
          if (paintedRow[globalX] > 0) continue;

          if (maskRow[x] > 0) {
            // Mark as painted
            paintedRow[globalX] = 255;

            // Apply alpha blending
            const float alpha = maskStrength;
            const float invAlpha = 1.0f - alpha;
            const int idx = globalX * channels;

            if (channels == 1) {
              // Grayscale
              float gray = (cr + cg + cb) / 3.0f;
              imgRow[idx] = static_cast<uchar>(imgRow[idx] * invAlpha + gray * alpha);
            } else if (channels == 3) {
              // RGB/BGR
              imgRow[idx]     = static_cast<uchar>(imgRow[idx]     * invAlpha + cb * alpha);
              imgRow[idx + 1] = static_cast<uchar>(imgRow[idx + 1] * invAlpha + cg * alpha);
              imgRow[idx + 2] = static_cast<uchar>(imgRow[idx + 2] * invAlpha + cr * alpha);
            } else if (channels == 4) {
              // RGBA/BGRA
              imgRow[idx]     = static_cast<uchar>(imgRow[idx]     * invAlpha + cb * alpha);
              imgRow[idx + 1] = static_cast<uchar>(imgRow[idx + 1] * invAlpha + cg * alpha);
              imgRow[idx + 2] = static_cast<uchar>(imgRow[idx + 2] * invAlpha + cr * alpha);
              // Keep alpha channel unchanged
            }
          }
        }
      }
    }

    taskMs = (cv::getTickCount() - t0) / cv::getTickFrequency() * 1e3;

    // Multi-format encoding if needed
    if (outputFormat != "raw") {
      cv::Mat tmp = PrepareForEncoding(result, outputChannel, outputFormat);
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

  if (info.Length() < 7 || info.Length() > 10 || !info[info.Length() - 1].IsFunction()) {
    Napi::TypeError::New(env, "addMasks(image, masksArray, classColorMap, classPriorityOrder, maskStrength, autoGenerateColors, [outputFormat], [quality], [pngOptimize], callback)")
      .ThrowAsJavaScriptException();
    return env.Null();
  }

  Napi::Value jsImg = info[0];
  Napi::Array masksArray = info[1].As<Napi::Array>();
  Napi::Object classColorMap = info[2].As<Napi::Object>();
  Napi::Array classPriorityOrder = info[3].As<Napi::Array>();
  double maskStrength = info[4].As<Napi::Number>().DoubleValue();
  bool autoGenerateColors = info[5].As<Napi::Boolean>().Value();

  maskStrength = std::max(0.0, std::min(1.0, maskStrength));

  std::string outputFormat = "raw";
  int quality = 90;
  bool pngOptimize = false;
  size_t cbIdx = 6;

  if (info.Length() >= 8) {
    outputFormat = info[6].As<Napi::String>().Utf8Value();
    cbIdx = 7;
  }

  if (info.Length() >= 9) {
    quality = info[7].As<Napi::Number>().Int32Value();
    cbIdx = 8;
  }

  if (info.Length() == 10) {
    pngOptimize = info[8].As<Napi::Boolean>().Value();
    cbIdx = 9;
  }

  (new AddMasksOptimizedWorker(
    info[cbIdx].As<Napi::Function>(),
    jsImg, masksArray, classColorMap, classPriorityOrder, maskStrength, autoGenerateColors,
    outputFormat, quality, pngOptimize
  ))->Queue();

  return env.Undefined();
}
