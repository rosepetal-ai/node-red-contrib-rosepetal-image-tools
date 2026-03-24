#include <napi.h>
#include <opencv2/opencv.hpp>
#include "utils.h"
#include <unordered_map>
#include <vector>
#include <string>
#include <cmath>
#include <algorithm>
// OpenMP is only used through pragmas; omit the header to avoid requiring libomp headers on macOS.
// #include <omp.h>
// SSE2 header removed - was unused and breaks ARM builds (emmintrin.h is x86/x64 only)

// Structure for bounding box information
struct BBoxInfo {
  cv::Rect boundingRect;     // Pixel coordinates
  std::string className;
  float confidence;
  cv::Scalar bgrColor;       // Pre-computed BGR color (0-255)
  std::string labelText;     // Pre-computed label text
  cv::Size textSize;         // Cached text size
  int baseline;              // Cached baseline
};

// Color generation function for unmapped classes
inline cv::Vec3f GenerateMaximallyDifferentColor(
    const std::string& className,
    const std::unordered_map<std::string, cv::Vec3f>& userColors,
    std::unordered_map<std::string, cv::Vec3f>& colorCache) {

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
        float saturation = 0.6f + s * 0.2f;
        float value = 0.6f + v * 0.2f;

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

  colorCache[className] = bestColor;
  return bestColor;
}

/*------------------------------------------------------------------------*/
class AddBBsWorker final : public Napi::AsyncWorker {
public:
  AddBBsWorker(Napi::Function cb,
               const Napi::Value& jsImg,
               const Napi::Array& boxesArray,
               const Napi::Object& classColorMap,
               bool showClassName,
               bool showConfidence,
               bool onlyMapped,
               int boxThickness,
               double fontSize,
               std::string fontPosition,
               bool labelBackground,
               std::string outputFormat,
               int quality = 90,
               bool pngOptimize = false)
    : Napi::AsyncWorker(cb),
      showClassName(showClassName),
      showConfidence(showConfidence),
      onlyMapped(onlyMapped),
      boxThickness(boxThickness),
      fontSize(fontSize),
      fontPosition(std::move(fontPosition)),
      labelBackground(labelBackground),
      outputFormat(std::move(outputFormat)),
      quality(quality),
      pngOptimize(pngOptimize)
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
        // Debug: Print parsed color
        // printf("Class %s: hex=%s -> BGR=(%.2f,%.2f,%.2f)\n", className.c_str(), hexColor.c_str(), b, g, r);
      }
    }

    // Reserve capacity for better performance
    bboxInfos.reserve(32); // Reserve for typical number of boxes

    // Parse boxes array structure - direct array format
    for (size_t boxIndex = 0; boxIndex < boxesArray.Length(); boxIndex++) {
      Napi::Object boxObj = boxesArray.Get(boxIndex).As<Napi::Object>();

      if (boxObj.Has("raw_boxes") && boxObj.Has("tag")) {
        // Extract box coordinates (4 corners format)
        Napi::Array box = boxObj.Get("raw_boxes").As<Napi::Array>();
        if (box.Length() != 4) continue;

        // Parse 4 corners: [[x1,y1], [x2,y1], [x2,y2], [x1,y2]]
        std::vector<cv::Point2f> corners;
        for (size_t i = 0; i < 4; i++) {
          Napi::Array corner = box.Get(i).As<Napi::Array>();
          if (corner.Length() >= 2) {
            float x = corner.Get(0u).As<Napi::Number>().FloatValue();
            float y = corner.Get(1u).As<Napi::Number>().FloatValue();
            corners.emplace_back(x, y);
          }
        }

        if (corners.size() != 4) continue;

        // Extract tag (class name) and confidence
        std::string className = boxObj.Get("tag").As<Napi::String>().Utf8Value();
        float confidence = boxObj.Has("confidence") ?
                          boxObj.Get("confidence").As<Napi::Number>().FloatValue() : 1.0f;

        // Skip unmapped classes if onlyMapped is true
        if (onlyMapped) {
          if (userColorMap.find(className) == userColorMap.end()) {
            continue; // Skip this box
          }
        }

        // Get color for this class and pre-compute BGR scalar
        cv::Vec3f color;
        auto colorIt = userColorMap.find(className);
        if (colorIt != userColorMap.end()) {
          color = colorIt->second;
        } else {
          color = GenerateMaximallyDifferentColor(className, userColorMap, colorCache);
        }

        // Pre-compute BGR color as Scalar for faster drawing
        cv::Scalar bgrColor(
          color[0] * 255.0f,  // B
          color[1] * 255.0f,  // G
          color[2] * 255.0f   // R
        );

        // Convert normalized coordinates to pixels (supports rotated boxes)
        float minX = corners[0].x, maxX = corners[0].x;
        float minY = corners[0].y, maxY = corners[0].y;
        for (int i = 1; i < 4; i++) {
          minX = std::min(minX, corners[i].x);
          maxX = std::max(maxX, corners[i].x);
          minY = std::min(minY, corners[i].y);
          maxY = std::max(maxY, corners[i].y);
        }
        cv::Rect bbox;
        bbox.x = static_cast<int>(minX * imageMat.cols);
        bbox.y = static_cast<int>(minY * imageMat.rows);
        bbox.width = static_cast<int>((maxX - minX) * imageMat.cols);
        bbox.height = static_cast<int>((maxY - minY) * imageMat.rows);

        // Clamp to image bounds
        bbox.x = std::max(0, std::min(imageMat.cols - 1, bbox.x));
        bbox.y = std::max(0, std::min(imageMat.rows - 1, bbox.y));
        bbox.width = std::min(bbox.width, imageMat.cols - bbox.x);
        bbox.height = std::min(bbox.height, imageMat.rows - bbox.y);

        // Pre-generate label text with optimized string handling
        char labelBuffer[256];
        if (showClassName && showConfidence) {
          snprintf(labelBuffer, sizeof(labelBuffer), "%s (%.1f%%)", className.c_str(), confidence * 100.0f);
        } else if (showClassName) {
          snprintf(labelBuffer, sizeof(labelBuffer), "%s", className.c_str());
        } else if (showConfidence) {
          snprintf(labelBuffer, sizeof(labelBuffer), "%.1f%%", confidence * 100.0f);
        } else {
          labelBuffer[0] = '\0';
        }
        std::string labelText(labelBuffer);

        // Store bbox info with pre-computed values
        BBoxInfo info;
        info.boundingRect = bbox;
        info.className = className;
        info.confidence = confidence;
        info.bgrColor = bgrColor;
        info.labelText = labelText;
        bboxInfos.push_back(info);
      }
    }

    imageFormat = DetectChannelFormatShared(jsImg, imageMat);
    outputChannel = imageFormat;

    convertMs = (cv::getTickCount() - t0) / cv::getTickFrequency() * 1e3;
  }

protected:
  void Execute() override {
    const int64 t0 = cv::getTickCount();

    // Work directly on the image if possible, avoid clone
    bool needsConversion = (imageFormat == "RGB" || imageFormat == "RGBA" || imageFormat == "GRAY");

    if (needsConversion) {
      // Convert and work on result directly
      if (imageFormat == "RGB") {
        cv::cvtColor(imageMat, result, cv::COLOR_RGB2BGR);
      } else if (imageFormat == "RGBA") {
        cv::cvtColor(imageMat, result, cv::COLOR_RGBA2BGR);
      } else if (imageFormat == "GRAY") {
        cv::cvtColor(imageMat, result, cv::COLOR_GRAY2BGR);
      }
    } else {
      // Already BGR/BGRA - clone only if needed
      result = imageMat.clone();
    }

    // Calculate scaling factor based on image dimensions
    // Use geometric mean of dimensions, normalized to ~500px reference size
    const double scaleFactor = std::sqrt(result.cols * result.rows) / 500.0;

    // Scale box thickness and font size proportionally
    const int actualBoxThickness = std::max(1, static_cast<int>(boxThickness * scaleFactor * 0.5));
    // Font scale needs to be much larger for OpenCV (typically 0.5-2.0)
    const double actualFontScale = fontSize * std::min(2.0, scaleFactor * 0.5);

    // Font settings
    const int fontFace = cv::FONT_HERSHEY_SIMPLEX;
    const double fontScale = actualFontScale;
    const int fontThickness = std::max(1, static_cast<int>(scaleFactor * 0.5));

    // Pre-calculate text sizes for all boxes with optimized caching
    std::unordered_map<std::string, std::pair<cv::Size, int>> textSizeCache;

    // First pass: calculate unique text sizes
    for (auto& bbox : bboxInfos) {
      if (!bbox.labelText.empty() && textSizeCache.find(bbox.labelText) == textSizeCache.end()) {
        int baseline = 0;
        cv::Size size = cv::getTextSize(bbox.labelText, fontFace, fontScale, fontThickness, &baseline);
        textSizeCache[bbox.labelText] = {size, baseline};
      }
    }

    // Second pass: assign cached sizes
    #pragma omp parallel for if(bboxInfos.size() > 20) schedule(static)
    for (size_t i = 0; i < bboxInfos.size(); i++) {
      auto& bbox = bboxInfos[i];
      if (!bbox.labelText.empty()) {
        const auto& cached = textSizeCache[bbox.labelText];
        bbox.textSize = cached.first;
        bbox.baseline = cached.second;
      }
    }

    // Process each bounding box
    for (const auto& bbox : bboxInfos) {
      // Draw bounding box rectangle with faster LINE_4
      cv::rectangle(result, bbox.boundingRect, bbox.bgrColor, actualBoxThickness, cv::LINE_4);

      // Draw label if there's text
      if (!bbox.labelText.empty()) {

        // Pre-calculated positions
        const int textX = bbox.boundingRect.x + 2;
        const int textY = bbox.boundingRect.y - 3;

        // Always draw background rectangle above the box (full opacity)
        if (labelBackground) {
          // Pre-calculate and clamp coordinates
          const int bgX1 = std::max(0, bbox.boundingRect.x);
          const int bgY1 = std::max(0, bbox.boundingRect.y - bbox.textSize.height - 6);
          const int bgX2 = std::min(result.cols - 1, bbox.boundingRect.x + bbox.textSize.width + 4);
          const int bgY2 = std::min(result.rows - 1, bbox.boundingRect.y - 1);

          // Full opacity background with bbox color
          cv::rectangle(result, cv::Point(bgX1, bgY1), cv::Point(bgX2, bgY2), bbox.bgrColor, cv::FILLED);
        }

        // Draw text with faster LINE_8 instead of LINE_AA
        cv::Scalar textColor = labelBackground ? cv::Scalar(0, 0, 0) : bbox.bgrColor;
        cv::putText(result, bbox.labelText, cv::Point(textX, textY), fontFace, fontScale, textColor, fontThickness, cv::LINE_8);
      }
    }

    taskMs = (cv::getTickCount() - t0) / cv::getTickFrequency() * 1e3;

    // Convert back to original format if needed
    if (outputFormat == "raw") {
      // Convert BGR result back to original format for raw output
      if (imageFormat == "RGB") {
        cv::cvtColor(result, result, cv::COLOR_BGR2RGB);
      } else if (imageFormat == "RGBA") {
        cv::cvtColor(result, result, cv::COLOR_BGR2RGBA);
      } else if (imageFormat == "GRAY") {
        cv::cvtColor(result, result, cv::COLOR_BGR2GRAY);
      }
      // If already BGR/BGRA, no conversion needed
    } else {
      // For encoded formats, keep as BGR
      cv::Mat tmp = result;
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
    out.Set("boxCount", Napi::Number::New(env, bboxInfos.size()));
    Callback().Call({env.Null(), out});
  }

private:
  cv::Mat imageMat, result;
  std::string imageFormat, outputChannel;
  std::vector<BBoxInfo> bboxInfos;
  bool showClassName, showConfidence, onlyMapped, labelBackground;
  int boxThickness;
  double fontSize;
  std::string fontPosition;
  std::string outputFormat;
  int quality;
  bool pngOptimize;
  double convertMs = 0, taskMs = 0, encodeMs = 0;
  std::vector<uchar> encodedBuf;
  std::unordered_map<std::string, cv::Vec3f> colorCache; // Instance-based color cache
};

/*------------------------------------------------------------------------*/
Napi::Value AddBBs(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  // Parameter validation
  if (info.Length() < 12 || info.Length() > 15 || !info[info.Length() - 1].IsFunction()) {
    Napi::TypeError::New(env, "addBBs(image, boxesArray, classColorMap, showClassName, showConfidence, onlyMapped, boxThickness, fontSize, fontPosition, labelBackground, [outputFormat], [quality], [pngOptimize], callback)")
      .ThrowAsJavaScriptException();
    return env.Null();
  }

  // Extract required parameters
  Napi::Value jsImg = info[0];
  Napi::Array boxesArray = info[1].As<Napi::Array>();
  Napi::Object classColorMap = info[2].As<Napi::Object>();
  bool showClassName = info[3].As<Napi::Boolean>().Value();
  bool showConfidence = info[4].As<Napi::Boolean>().Value();
  bool onlyMapped = info[5].As<Napi::Boolean>().Value();
  int boxThickness = info[6].As<Napi::Number>().Int32Value();
  double fontSize = info[7].As<Napi::Number>().DoubleValue();
  std::string fontPosition = info[8].As<Napi::String>().Utf8Value();
  bool labelBackground = info[9].As<Napi::Boolean>().Value();

  // Handle optional parameters
  std::string outputFormat = "raw";
  int quality = 90;
  bool pngOptimize = false;
  size_t cbIdx = 10;

  if (info.Length() >= 12) {
    outputFormat = info[10].As<Napi::String>().Utf8Value();
    cbIdx = 11;
  }

  if (info.Length() >= 13) {
    quality = info[11].As<Napi::Number>().Int32Value();
    cbIdx = 12;
  }

  if (info.Length() >= 14) {
    pngOptimize = info[12].As<Napi::Boolean>().Value();
    cbIdx = 13;
  }

  // Create and queue worker
  (new AddBBsWorker(
    info[cbIdx].As<Napi::Function>(),
    jsImg, boxesArray, classColorMap,
    showClassName, showConfidence, onlyMapped,
    boxThickness, fontSize, fontPosition, labelBackground,
    outputFormat, quality, pngOptimize
  ))->Queue();

  return env.Undefined();
}
