// draw.cpp - draw points and lines on images using OpenCV (ULTRA-OPTIMIZED)
#include <napi.h>
#include <opencv2/opencv.hpp>
#include <vector>
#include <array>
#include <algorithm>
#include <cmath>
#include <cstring>
#include "utils.h"

namespace {
struct DrawPoint {
  float x;
  float y;
  float radius;
  std::array<float, 4> color; // B, G, R, A normalized [0,1]
};

struct DrawLine {
  float x1;
  float y1;
  float x2;
  float y2;
  float thickness;
  std::array<float, 4> color; // B, G, R, A normalized [0,1]
};

float Clamp01(float value) {
  return std::max(0.0f, std::min(1.0f, value));
}

int ClampPixel(int value, int maxExclusive) {
  if (maxExclusive <= 0) return 0;
  return std::max(0, std::min(maxExclusive - 1, value));
}

// ULTRA-FAST: ROI-based blending - only process affected pixels
inline void UltraFastBlend(cv::Mat& canvas, const cv::Mat& mask,
                          const std::array<float, 4>& color,
                          const cv::Rect& roi) {
  const int channels = canvas.channels();

  // Extract ROI for faster processing
  cv::Mat canvasROI = canvas(roi);
  cv::Mat maskROI = mask(roi);

  if (channels == 1) {
    // Grayscale: vectorized operation
    const float intensity = Clamp01(color[2] * 0.299f + color[1] * 0.587f + color[0] * 0.114f);

    cv::Mat colorMat;
    cv::multiply(maskROI, cv::Scalar(intensity), colorMat);
    cv::addWeighted(canvasROI, 1.0, colorMat, 1.0, 0.0, canvasROI);
    cv::min(canvasROI, 1.0, canvasROI);

  } else if (channels == 3) {
    // RGB/BGR: Use optimized vectorized operations
    const cv::Scalar colorScalar(color[0], color[1], color[2]);

    // Create inverse mask
    cv::Mat invMask;
    cv::subtract(1.0f, maskROI, invMask);

    // Vectorized blending: canvas = canvas * (1-alpha) + color * alpha
    std::vector<cv::Mat> canvasChannels;
    cv::split(canvasROI, canvasChannels);

    cv::Mat colorMask0, colorMask1, colorMask2;
    cv::multiply(maskROI, colorScalar[0], colorMask0);
    cv::multiply(maskROI, colorScalar[1], colorMask1);
    cv::multiply(maskROI, colorScalar[2], colorMask2);

    cv::multiply(canvasChannels[0], invMask, canvasChannels[0]);
    cv::multiply(canvasChannels[1], invMask, canvasChannels[1]);
    cv::multiply(canvasChannels[2], invMask, canvasChannels[2]);

    canvasChannels[0] += colorMask0;
    canvasChannels[1] += colorMask1;
    canvasChannels[2] += colorMask2;

    cv::merge(canvasChannels, canvasROI);
    cv::min(canvasROI, 1.0, canvasROI);

  } else if (channels == 4) {
    // RGBA/BGRA: Include alpha channel
    const cv::Scalar colorScalar(color[0], color[1], color[2], color[3]);

    cv::Mat invMask;
    cv::subtract(1.0f, maskROI, invMask);

    std::vector<cv::Mat> canvasChannels;
    cv::split(canvasROI, canvasChannels);

    cv::Mat colorMask[4];
    for (int i = 0; i < 4; ++i) {
      cv::multiply(maskROI, colorScalar[i], colorMask[i]);
      cv::multiply(canvasChannels[i], invMask, canvasChannels[i]);
      canvasChannels[i] += colorMask[i];
    }

    cv::merge(canvasChannels, canvasROI);
    cv::min(canvasROI, 1.0, canvasROI);
  }
}

} // namespace

class DrawWorker final : public Napi::AsyncWorker {
public:
  DrawWorker(Napi::Function& callback,
             const Napi::Value& jsImage,
             const Napi::Value& jsPoints,
             const Napi::Value& jsLines,
             std::string outputFormat,
             int quality,
             bool pngOptimize)
    : Napi::AsyncWorker(callback),
      outputFormat(std::move(outputFormat)),
      quality(quality),
      pngOptimize(pngOptimize) {

    const int64 t0 = cv::getTickCount();
    baseImage = ConvertToMat(jsImage);
    convertMs = (cv::getTickCount() - t0) / cv::getTickFrequency() * 1e3;

    imageChannelOrder = DetectChannelFormatShared(jsImage, baseImage);
    ParsePoints(jsPoints);
    ParseLines(jsLines);
  }

protected:
  void Execute() override {
    const int64 t0 = cv::getTickCount();

    const int width = baseImage.cols;
    const int height = baseImage.rows;
    if (width <= 0 || height <= 0) {
      throw std::runtime_error("Input image has invalid dimensions");
    }

    // Early exit if nothing to draw
    if (points.empty() && lines.empty()) {
      resultImage = baseImage.clone();
      taskMs = (cv::getTickCount() - t0) / cv::getTickFrequency() * 1e3;
      return;
    }

    // Determine processing format (OpenCV expects BGR/BGRA)
    const int channels = baseImage.channels();
    std::string processingOrder;
    if (channels == 1) {
      processingOrder = "GRAY";
    } else if (channels == 3) {
      processingOrder = "BGR";
    } else if (channels == 4) {
      processingOrder = "BGRA";
    } else {
      throw std::runtime_error("Unsupported channel count for draw node");
    }

    cv::Mat working = ConvertToTargetFormatShared(baseImage, imageChannelOrder, processingOrder);

    // OPTIMIZATION: Convert to float once, operate in-place
    const int targetType =
      (channels == 1) ? CV_32FC1 :
      (channels == 3) ? CV_32FC3 :
                        CV_32FC4;

    cv::Mat canvas;
    working.convertTo(canvas, targetType, 1.0 / 255.0);

    const float minDimension = static_cast<float>(std::max(1, std::min(width, height)));

    // ULTRA-OPTIMIZATION: Pre-allocate mask buffer once
    cv::Mat maskBuffer(canvas.rows, canvas.cols, CV_32FC1);

    // Process all points
    for (const auto& point : points) {
      ApplyPointUltraFast(canvas, maskBuffer, point, width, height, minDimension);
    }

    // Process all lines
    for (const auto& line : lines) {
      ApplyLineUltraFast(canvas, maskBuffer, line, width, height, minDimension);
    }

    // OPTIMIZATION: Single clamping pass
    cv::min(canvas, 1.0, canvas);
    cv::max(canvas, 0.0, canvas);

    // Convert back to uint8
    canvas.convertTo(working,
                     (channels == 1) ? CV_8UC1 :
                     (channels == 3) ? CV_8UC3 :
                                       CV_8UC4,
                     255.0);

    if (processingOrder != imageChannelOrder) {
      resultImage = ConvertToTargetFormatShared(working, processingOrder, imageChannelOrder);
    } else {
      resultImage = working;
    }

    if (outputFormat != "raw") {
      cv::Mat encodeSrc = ToBgrForJpg(resultImage, imageChannelOrder);
      encodeMs = EncodeToFormat(encodeSrc, encodedBuffer, outputFormat, quality, pngOptimize);
    }

    taskMs = (cv::getTickCount() - t0) / cv::getTickFrequency() * 1e3;
  }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::Value outImage =
      (outputFormat != "raw")
        ? VectorToBuffer(env, std::move(encodedBuffer))
        : MatToRawJS(env, resultImage, imageChannelOrder);

    Napi::Object response = Napi::Object::New(env);
    response.Set("image", outImage);
    response.Set("timing", MakeTimingJS(env, convertMs, taskMs, encodeMs));
    Callback().Call({ env.Null(), response });
  }

private:
  void ParsePoints(const Napi::Value& value) {
    if (!value.IsArray()) return;
    Napi::Array arr = value.As<Napi::Array>();
    points.reserve(arr.Length());
    for (uint32_t i = 0; i < arr.Length(); ++i) {
      Napi::Value entry = arr.Get(i);
      if (!entry.IsObject()) continue;
      Napi::Object obj = entry.As<Napi::Object>();

      if (!obj.Has("x") || !obj.Has("y") || !obj.Has("radius") ||
          !obj.Has("r") || !obj.Has("g") || !obj.Has("b") || !obj.Has("a")) {
        continue;
      }

      DrawPoint pt;
      pt.x = Clamp01(obj.Get("x").As<Napi::Number>().FloatValue());
      pt.y = Clamp01(obj.Get("y").As<Napi::Number>().FloatValue());
      pt.radius = Clamp01(obj.Get("radius").As<Napi::Number>().FloatValue());
      const float r = Clamp01(obj.Get("r").As<Napi::Number>().FloatValue() / 255.0f);
      const float g = Clamp01(obj.Get("g").As<Napi::Number>().FloatValue() / 255.0f);
      const float b = Clamp01(obj.Get("b").As<Napi::Number>().FloatValue() / 255.0f);
      const float a = Clamp01(obj.Get("a").As<Napi::Number>().FloatValue());
      pt.color = { b, g, r, a };
      points.push_back(pt);
    }
  }

  void ParseLines(const Napi::Value& value) {
    if (!value.IsArray()) return;
    Napi::Array arr = value.As<Napi::Array>();
    lines.reserve(arr.Length());
    for (uint32_t i = 0; i < arr.Length(); ++i) {
      Napi::Value entry = arr.Get(i);
      if (!entry.IsObject()) continue;
      Napi::Object obj = entry.As<Napi::Object>();

      if (!obj.Has("x1") || !obj.Has("y1") || !obj.Has("x2") || !obj.Has("y2") ||
          !obj.Has("thickness") ||
          !obj.Has("r") || !obj.Has("g") || !obj.Has("b") || !obj.Has("a")) {
        continue;
      }

      DrawLine line;
      line.x1 = Clamp01(obj.Get("x1").As<Napi::Number>().FloatValue());
      line.y1 = Clamp01(obj.Get("y1").As<Napi::Number>().FloatValue());
      line.x2 = Clamp01(obj.Get("x2").As<Napi::Number>().FloatValue());
      line.y2 = Clamp01(obj.Get("y2").As<Napi::Number>().FloatValue());
      line.thickness = Clamp01(obj.Get("thickness").As<Napi::Number>().FloatValue());
      const float r = Clamp01(obj.Get("r").As<Napi::Number>().FloatValue() / 255.0f);
      const float g = Clamp01(obj.Get("g").As<Napi::Number>().FloatValue() / 255.0f);
      const float b = Clamp01(obj.Get("b").As<Napi::Number>().FloatValue() / 255.0f);
      const float a = Clamp01(obj.Get("a").As<Napi::Number>().FloatValue());
      line.color = { b, g, r, a };
      lines.push_back(line);
    }
  }

  // ULTRA-FAST: ROI-based rendering with minimal mask operations
  void ApplyPointUltraFast(cv::Mat& canvas,
                           cv::Mat& maskBuffer,
                           const DrawPoint& point,
                           int width,
                           int height,
                           float minDimension) {
    if (point.radius <= 0.0f || point.color[3] < 1e-6f) {
      return; // Skip invisible points
    }

    const int radiusPx = std::max(1, static_cast<int>(std::round(point.radius * minDimension)));
    const int px = ClampPixel(static_cast<int>(std::round(point.x * (width - 1))), width);
    const int py = ClampPixel(static_cast<int>(std::round(point.y * (height - 1))), height);

    // Calculate bounding box for ROI optimization
    const int x1 = std::max(0, px - radiusPx);
    const int y1 = std::max(0, py - radiusPx);
    const int x2 = std::min(width, px + radiusPx + 1);
    const int y2 = std::min(height, py + radiusPx + 1);

    if (x1 >= x2 || y1 >= y2) return; // Empty ROI

    const cv::Rect roi(x1, y1, x2 - x1, y2 - y1);

    // ULTRA-OPTIMIZATION: Zero only the ROI instead of full mask
    cv::Mat maskROI = maskBuffer(roi);
    maskROI.setTo(0);

    // Draw circle on ROI with adjusted center
    cv::circle(maskBuffer, cv::Point(px, py), radiusPx, cv::Scalar(point.color[3]), -1, cv::LINE_AA);

    // Blend only the affected region
    UltraFastBlend(canvas, maskBuffer, point.color, roi);
  }

  // ULTRA-FAST: ROI-based line rendering
  void ApplyLineUltraFast(cv::Mat& canvas,
                          cv::Mat& maskBuffer,
                          const DrawLine& line,
                          int width,
                          int height,
                          float minDimension) {
    if (line.color[3] < 1e-6f) {
      return; // Skip invisible lines
    }

    if ((line.x1 == line.x2) && (line.y1 == line.y2)) {
      return;
    }

    const int thicknessPx = std::max(1, static_cast<int>(std::round(line.thickness * minDimension)));
    const int p1x = ClampPixel(static_cast<int>(std::round(line.x1 * (width - 1))), width);
    const int p1y = ClampPixel(static_cast<int>(std::round(line.y1 * (height - 1))), height);
    const int p2x = ClampPixel(static_cast<int>(std::round(line.x2 * (width - 1))), width);
    const int p2y = ClampPixel(static_cast<int>(std::round(line.y2 * (height - 1))), height);

    const cv::Point p1(p1x, p1y);
    const cv::Point p2(p2x, p2y);

    // Calculate bounding box for line ROI
    const int halfThick = thicknessPx / 2 + 1;
    const int x1 = std::max(0, std::min(p1x, p2x) - halfThick);
    const int y1 = std::max(0, std::min(p1y, p2y) - halfThick);
    const int x2 = std::min(width, std::max(p1x, p2x) + halfThick + 1);
    const int y2 = std::min(height, std::max(p1y, p2y) + halfThick + 1);

    if (x1 >= x2 || y1 >= y2) return; // Empty ROI

    const cv::Rect roi(x1, y1, x2 - x1, y2 - y1);

    // ULTRA-OPTIMIZATION: Zero only the ROI
    cv::Mat maskROI = maskBuffer(roi);
    maskROI.setTo(0);

    cv::line(maskBuffer, p1, p2, cv::Scalar(line.color[3]), thicknessPx, cv::LINE_AA);

    // Blend only the affected region
    UltraFastBlend(canvas, maskBuffer, line.color, roi);
  }

private:
  cv::Mat baseImage;
  cv::Mat resultImage;
  std::vector<uchar> encodedBuffer;

  std::vector<DrawPoint> points;
  std::vector<DrawLine> lines;

  std::string imageChannelOrder;
  std::string outputFormat;
  int quality;
  bool pngOptimize;

  double convertMs {0.0};
  double taskMs {0.0};
  double encodeMs {0.0};
};

Napi::Value Draw(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const size_t length = info.Length();
  if (length < 4 || length > 7 || !info[length - 1].IsFunction()) {
    Napi::TypeError::New(env,
      "draw(image, points, lines, [outputFormat], [quality], [pngOptimize], callback)")
      .ThrowAsJavaScriptException();
    return env.Null();
  }

  size_t idx = 0;
  Napi::Value imageVal = info[idx++];
  Napi::Value pointsVal = info[idx++];
  Napi::Value linesVal = info[idx++];

  std::string outputFormat = "raw";
  int quality = 90;
  bool pngOptimize = false;

  if (idx < length - 1) {
    outputFormat = info[idx++].As<Napi::String>().Utf8Value();
  }
  if (idx < length - 1) {
    quality = info[idx++].As<Napi::Number>().Int32Value();
  }
  if (idx < length - 1) {
    pngOptimize = info[idx++].As<Napi::Boolean>().Value();
  }

  Napi::Function cb = info[length - 1].As<Napi::Function>();
  (new DrawWorker(cb, imageVal, pointsVal, linesVal, outputFormat, quality, pngOptimize))->Queue();
  return env.Undefined();
}
