#include <napi.h>
#include <opencv2/opencv.hpp>
#include "utils.h"
#include <unordered_map>
#include <random>

// Structure to hold mask information
struct MaskInfo {
  std::vector<cv::Point2f> polygon;
  std::string className;
  cv::Scalar color;
};

// Helper function to create binary mask from polygon coordinates
cv::Mat CreatePolygonMaskMulti(const std::vector<cv::Point2f>& polygon, cv::Size imageSize) {
  // Create empty binary mask (grayscale, black background)
  cv::Mat mask = cv::Mat::zeros(imageSize, CV_8UC1);

  // Convert normalized coordinates to pixel coordinates
  std::vector<cv::Point> pixelPolygon;
  pixelPolygon.reserve(polygon.size());

  for (const auto& point : polygon) {
    int x = static_cast<int>(point.x * imageSize.width);
    int y = static_cast<int>(point.y * imageSize.height);

    // Clamp to image bounds
    x = std::max(0, std::min(imageSize.width - 1, x));
    y = std::max(0, std::min(imageSize.height - 1, y));

    pixelPolygon.emplace_back(x, y);
  }

  // Fill polygon with white (255) on binary mask
  const cv::Point* pts = pixelPolygon.data();
  int npts = static_cast<int>(pixelPolygon.size());
  cv::fillPoly(mask, &pts, &npts, 1, cv::Scalar(255)); // White fill for binary mask

  return mask;
}

// Helper function to generate random color based on class name (for consistency)
cv::Scalar GenerateRandomColor(const std::string& className) {
  std::hash<std::string> hasher;
  size_t seed = hasher(className);
  std::mt19937 rng(seed);
  std::uniform_int_distribution<int> dist(0, 255);

  // Generate colors in HSV space for better visual distinction
  int hue = rng() % 360;
  int saturation = 70 + (rng() % 30); // 70-100% saturation
  int value = 70 + (rng() % 30);      // 70-100% value

  // Convert HSV to RGB
  cv::Mat hsv(1, 1, CV_8UC3, cv::Scalar(hue / 2, saturation * 255 / 100, value * 255 / 100));
  cv::Mat rgb;
  cv::cvtColor(hsv, rgb, cv::COLOR_HSV2RGB);

  cv::Vec3b pixel = rgb.at<cv::Vec3b>(0, 0);
  return cv::Scalar(pixel[2], pixel[1], pixel[0]); // BGR for OpenCV
}

/*------------------------------------------------------------------------*/
class AddMasksWorker final : public Napi::AsyncWorker {
public:
  AddMasksWorker(Napi::Function cb,
                 const Napi::Value& jsImg,
                 const Napi::Array& masksArray,
                 const Napi::Object& classColorMap,
                 double maskStrength,
                 bool autoGenerateColors,
                 std::string outputFormat,
                 int quality = 90,
                 bool pngOptimize = false)
    : Napi::AsyncWorker(cb),
      maskStrength(maskStrength),
      autoGenerateColors(autoGenerateColors),
      outputFormat(std::move(outputFormat)),
      quality(quality), pngOptimize(pngOptimize)
  {
    // Timing and conversion
    const int64 t0 = cv::getTickCount();

    // Convert JavaScript image to OpenCV Mat
    imageMat = ConvertToMat(jsImg);

    // Parse class color map from JavaScript object
    std::unordered_map<std::string, cv::Scalar> colorMap;
    Napi::Array colorMapKeys = classColorMap.GetPropertyNames();
    for (size_t i = 0; i < colorMapKeys.Length(); i++) {
      std::string className = colorMapKeys.Get(i).As<Napi::String>().Utf8Value();
      std::string hexColor = classColorMap.Get(className).As<Napi::String>().Utf8Value();

      // Convert hex color to BGR scalar
      if (hexColor.length() == 7 && hexColor[0] == '#') {
        int r = std::stoi(hexColor.substr(1, 2), nullptr, 16);
        int g = std::stoi(hexColor.substr(3, 2), nullptr, 16);
        int b = std::stoi(hexColor.substr(5, 2), nullptr, 16);
        colorMap[className] = cv::Scalar(b, g, r); // BGR for OpenCV
      }
    }

    // Parse masks array structure: masksArray[elementIndex].masks[maskIndex]
    for (size_t elementIndex = 0; elementIndex < masksArray.Length(); elementIndex++) {
      Napi::Object element = masksArray.Get(elementIndex).As<Napi::Object>();

      if (element.Has("masks")) {
        Napi::Array masks = element.Get("masks").As<Napi::Array>();

        for (size_t maskIndex = 0; maskIndex < masks.Length(); maskIndex++) {
          Napi::Object maskObj = masks.Get(maskIndex).As<Napi::Object>();

          if (maskObj.Has("mask") && maskObj.Has("class_name")) {
            // Get coordinates from mask[0]
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

              // Determine color for this class
              cv::Scalar color;
              if (colorMap.find(className) != colorMap.end()) {
                color = colorMap[className]; // Use user-defined color
              } else if (autoGenerateColors) {
                color = GenerateRandomColor(className); // Generate random color
              } else {
                color = cv::Scalar(255, 255, 255); // Default white
              }

              // Store mask information
              if (!polygon.empty()) {
                maskInfos.push_back({polygon, className, color});
              }
            }
          }
        }
      }
    }

    // Detect image channel format
    imageFormat = DetectChannelFormatShared(jsImg, imageMat);
    outputChannel = imageFormat;

    convertMs = (cv::getTickCount() - t0) / cv::getTickFrequency() * 1e3;
  }

protected:
  void Execute() override {
    const int64 t0 = cv::getTickCount();

    // Convert image to target format
    cv::Mat img = ConvertToTargetFormatShared(imageMat, imageFormat, outputChannel);

    // Convert image to float for precise blending
    cv::Mat imgFloat;
    img.convertTo(imgFloat, CV_32F, 1.0/255.0);

    // Create combined mask from all polygons
    cv::Mat combinedMask = cv::Mat::zeros(img.size(), CV_32FC3);
    cv::Mat totalWeights = cv::Mat::zeros(img.size(), CV_32F);

    // Process each mask
    for (const auto& maskInfo : maskInfos) {
      // Generate binary mask from polygon coordinates
      cv::Mat binaryMask = CreatePolygonMaskMulti(maskInfo.polygon, img.size());

      // Convert binary mask to float weights (0.0 to 1.0)
      cv::Mat maskWeights;
      binaryMask.convertTo(maskWeights, CV_32F, 1.0/255.0);

      // Apply mask strength to weights
      maskWeights *= maskStrength;

      // Create color mask with the class color
      cv::Mat colorMask;
      if (imgFloat.channels() == 1) {
        // Grayscale: use average of RGB values
        float grayValue = (maskInfo.color[2] + maskInfo.color[1] + maskInfo.color[0]) / (3.0f * 255.0f);
        colorMask = cv::Mat::ones(img.size(), CV_32F) * grayValue;
      } else if (imgFloat.channels() == 3) {
        // Color image - respect the color space format
        colorMask = cv::Mat::ones(img.size(), CV_32FC3);
        if (outputChannel == "RGB" || outputChannel == "RGBA") {
          // RGB format: R, G, B order
          colorMask.setTo(cv::Scalar(maskInfo.color[2]/255.0f, maskInfo.color[1]/255.0f, maskInfo.color[0]/255.0f));
        } else {
          // BGR format: B, G, R order (OpenCV default)
          colorMask.setTo(cv::Scalar(maskInfo.color[0]/255.0f, maskInfo.color[1]/255.0f, maskInfo.color[2]/255.0f));
        }
      } else if (imgFloat.channels() == 4) {
        // Color image with alpha
        colorMask = cv::Mat::ones(img.size(), CV_32FC4);
        if (outputChannel == "RGBA") {
          // RGBA format: R, G, B, A order
          colorMask.setTo(cv::Scalar(maskInfo.color[2]/255.0f, maskInfo.color[1]/255.0f, maskInfo.color[0]/255.0f, 1.0f));
        } else {
          // BGRA format: B, G, R, A order (OpenCV default)
          colorMask.setTo(cv::Scalar(maskInfo.color[0]/255.0f, maskInfo.color[1]/255.0f, maskInfo.color[2]/255.0f, 1.0f));
        }
      }

      // Replicate single channel weights to match image channels
      cv::Mat blendWeights;
      if (imgFloat.channels() > 1) {
        std::vector<cv::Mat> channels(imgFloat.channels());
        for (int i = 0; i < imgFloat.channels(); i++) {
          channels[i] = maskWeights;
        }
        cv::merge(channels, blendWeights);
      } else {
        blendWeights = maskWeights;
      }

      // Accumulate weighted color contributions
      cv::Mat weightedColor;
      cv::multiply(colorMask, blendWeights, weightedColor);
      cv::add(combinedMask, weightedColor, combinedMask);

      // Accumulate total weights for normalization
      cv::add(totalWeights, maskWeights, totalWeights);
    }

    // Create final blended result
    cv::Mat resultFloat;
    if (maskInfos.empty()) {
      // No masks to apply, return original image
      resultFloat = imgFloat.clone();
    } else {
      // Normalize combined mask by total weights to prevent over-saturation
      cv::Mat normalizedMask;
      cv::divide(combinedMask, cv::max(totalWeights, 0.001), normalizedMask); // Avoid division by zero

      // Replicate total weights to match image channels for inverse calculation
      cv::Mat totalWeightsMultiChannel;
      if (imgFloat.channels() > 1) {
        std::vector<cv::Mat> channels(imgFloat.channels());
        for (int i = 0; i < imgFloat.channels(); i++) {
          channels[i] = totalWeights;
        }
        cv::merge(channels, totalWeightsMultiChannel);
      } else {
        totalWeightsMultiChannel = totalWeights;
      }

      // Weighted blending: result = image * (1 - total_weights) + combined_mask
      cv::Mat inverseWeights;
      cv::subtract(cv::Scalar::all(1.0), totalWeightsMultiChannel, inverseWeights);

      // Element-wise multiplication and addition
      cv::Mat term1, term2;
      cv::multiply(imgFloat, inverseWeights, term1);
      cv::add(term1, normalizedMask, resultFloat);
    }

    // Convert back to 8-bit
    resultFloat.convertTo(result, CV_8U, 255.0);

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
  std::vector<MaskInfo> maskInfos;
  double maskStrength;
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

  // Parameter validation: image, masksArray, classColorMap, maskStrength, autoGenerateColors, [outputFormat], [quality], [pngOptimize], callback
  if (info.Length() < 6 || info.Length() > 9 || !info[info.Length() - 1].IsFunction()) {
    Napi::TypeError::New(env, "addMasks(image, masksArray, classColorMap, maskStrength, autoGenerateColors, [outputFormat], [quality], [pngOptimize], callback)")
      .ThrowAsJavaScriptException();
    return env.Null();
  }

  // Extract required parameters
  Napi::Value jsImg = info[0];
  Napi::Array masksArray = info[1].As<Napi::Array>();
  Napi::Object classColorMap = info[2].As<Napi::Object>();
  double maskStrength = info[3].As<Napi::Number>().DoubleValue();
  bool autoGenerateColors = info[4].As<Napi::Boolean>().Value();

  // Clamp mask strength to valid range
  maskStrength = std::max(0.0, std::min(1.0, maskStrength));

  // Handle optional parameters
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

  // Create and queue worker
  (new AddMasksWorker(
    info[cbIdx].As<Napi::Function>(),
    jsImg, masksArray, classColorMap, maskStrength, autoGenerateColors,
    outputFormat, quality, pngOptimize
  ))->Queue();

  return env.Undefined();
}