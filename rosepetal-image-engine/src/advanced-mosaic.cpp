// ───────── src/advanced-mosaic.cpp ───────────────────────────────────────────────
// ADVANCED MOSAIC - Ultra-optimized image compositing with per-image transformations
// Combines resize, rotate, and positioning in a single high-performance pipeline
#include <napi.h>
#include <opencv2/opencv.hpp>
#include <vector>
#include <algorithm>
#include <cmath>
#include <string>
#include "utils.h"

// Lightweight helpers for mask handling (aligned with add-masks inputs)
static inline std::string ExtractClassNameAdvanced(const Napi::Object& obj) {
  const std::vector<std::string> keys = {"tag", "class_name", "className", "label", "class"};
  for (const auto& key : keys) {
    if (obj.Has(key) && obj.Get(key).IsString()) {
      std::string value = obj.Get(key).As<Napi::String>().Utf8Value();
      if (!value.empty()) return value;
    }
  }
  return "";
}

static inline cv::Mat BuildMaskFrom2DArray(const Napi::Array& rows) {
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

// JS thread: parse normalized polygons (no rasterisation)
static inline std::vector<std::vector<cv::Point2d>> ParsePolygonsAdvanced(const Napi::Array& polygons) {
  std::vector<std::vector<cv::Point2d>> out;
  out.reserve(polygons.Length());
  for (uint32_t idx = 0; idx < polygons.Length(); idx++) {
    if (!polygons.Get(idx).IsArray()) continue;
    Napi::Array coords = polygons.Get(idx).As<Napi::Array>();
    if (coords.Length() == 0) continue;

    std::vector<cv::Point2d> points;
    points.reserve(coords.Length());
    for (uint32_t i = 0; i < coords.Length(); i++) {
      if (!coords.Get(i).IsArray()) continue;
      Napi::Array point = coords.Get(i).As<Napi::Array>();
      if (point.Length() >= 2 && point.Get(0u).IsNumber() && point.Get(1u).IsNumber()) {
        points.emplace_back(point.Get(0u).As<Napi::Number>().DoubleValue(),
                            point.Get(1u).As<Napi::Number>().DoubleValue());
      }
    }
    if (!points.empty()) out.push_back(std::move(points));
  }
  return out;
}

// Worker thread: rasterise normalized polygons into a binary mask
static inline cv::Mat RasterizePolygonsAdvanced(const std::vector<std::vector<cv::Point2d>>& polygons,
                                                const cv::Size& size) {
  if (polygons.empty() || size.width <= 0 || size.height <= 0) return cv::Mat();
  cv::Mat mask = cv::Mat::zeros(size, CV_8UC1);

  for (const auto& poly : polygons) {
    std::vector<cv::Point> points;
    points.reserve(poly.size());
    for (const auto& p : poly) {
      int px = static_cast<int>(std::round(p.x * size.width));
      int py = static_cast<int>(std::round(p.y * size.height));
      px = std::max(0, std::min(size.width - 1, px));
      py = std::max(0, std::min(size.height - 1, py));
      points.emplace_back(px, py);
    }
    if (points.size() >= 3) {
      const cv::Point* pts = points.data();
      int npts = static_cast<int>(points.size());
      cv::fillPoly(mask, &pts, &npts, 1, cv::Scalar(255), cv::LINE_4);
    }
  }

  return mask;
}

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
                       int quality,
                       bool pngOptimize,
                       bool hasMasks,
                       const Napi::Array& masksArray)
    : Napi::AsyncWorker(cb),
      canvasWidth_(canvasWidth), canvasHeight_(canvasHeight),
      backgroundColor_(backgroundColor),
      normalized_(normalized), outputFormat_(std::move(outputFormat)),
      quality_(quality), pngOptimize_(pngOptimize),
      hasMasks_(hasMasks)
  {
    // JS thread: metadata + persistent references only (no decode, no pixels)
    try {
      sources_.reserve(imagesArray.Length());
      for (uint32_t i = 0; i < imagesArray.Length(); i++) {
        sources_.emplace_back(CaptureImage(imagesArray[i]));
      }

      // Optional masks aligned with input images (parsed, not rasterised)
      if (hasMasks_) {
        pendingMasks_.resize(sources_.size());

        for (uint32_t i = 0; i < masksArray.Length() && i < sources_.size(); i++) {
          Napi::Value mv = masksArray.Get(i);
          PendingMask& pm = pendingMasks_[i];

          if (mv.IsObject() && !mv.IsArray() && !mv.IsBuffer()) {
            Napi::Object mObj = mv.As<Napi::Object>();
            pm.tag = ExtractClassNameAdvanced(mObj);

            if (mObj.Has("mask")) {
              Napi::Value inner = mObj.Get("mask");
              if (inner.IsArray()) {
                pm.arrayMask = BuildMaskFrom2DArray(inner.As<Napi::Array>());
                pm.kind = PendingMask::ARRAY;
              } else {
                pm.src = CaptureImage(inner);
                pm.kind = PendingMask::IMAGE;
              }
            } else if (mObj.Has("polygons") && mObj.Get("polygons").IsArray()) {
              pm.polygons = ParsePolygonsAdvanced(mObj.Get("polygons").As<Napi::Array>());
              pm.kind = PendingMask::POLYGONS;
            } else if (mObj.Has("data") && mObj.Has("width") && mObj.Has("height")) {
              pm.src = CaptureImage(mv);
              pm.kind = PendingMask::IMAGE;
            }
          } else if (mv.IsArray()) {
            pm.arrayMask = BuildMaskFrom2DArray(mv.As<Napi::Array>());
            pm.kind = PendingMask::ARRAY;
          } else if (mv.IsBuffer()) {
            pm.src = CaptureImage(mv);
            pm.kind = PendingMask::IMAGE;
          }
        }
      }
    } catch (const Napi::Error& e) {
      captureFailed_ = true; SetError(e.Message());
    } catch (const std::exception& e) {
      captureFailed_ = true; SetError(e.what());
    }

    imageConfigs_.reserve(imageConfigsArray.Length());
    
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
    
    // Check if any images have rotation to determine if we need alpha support
    bool hasRotation = false;
    for (const auto& config : imageConfigs_) {
      if (std::abs(config.rotation) > 1e-3) {
        hasRotation = true;
        break;
      }
    }
    
    hasRotation_ = hasRotation;
  }

protected:
  void Execute() override {
    if (captureFailed_) return;

    /* ─ Decode (encoded inputs only) + channel detection, worker thread ─ */
    int64 t0 = cv::getTickCount();
    images_.clear(); imageChannels_.clear();
    images_.reserve(sources_.size());
    imageChannels_.reserve(sources_.size());
    for (auto& s : sources_) {
      s.Materialize();
      images_.push_back(s.mat);
      imageChannels_.push_back(s.colorSpace);
    }

    // Determine the best canvas format, preferring RGBA if rotation is detected
    if (hasRotation_) {
      canvasChannel_ = "RGBA"; // Force RGBA for transparent rotation padding
    } else {
      canvasChannel_ = DetermineBestCanvasFormatAdvanced(imageChannels_);
    }

    // Optional masks: decode / rasterise / binarise (worker thread)
    if (hasMasks_) {
      masks_.assign(images_.size(), cv::Mat());
      maskTags_.assign(images_.size(), std::string());
      maskOutputs_.assign(images_.size(), cv::Mat());

      for (size_t i = 0; i < pendingMasks_.size() && i < images_.size(); i++) {
        PendingMask& pm = pendingMasks_[i];
        cv::Mat maskMat;
        switch (pm.kind) {
          case PendingMask::ARRAY:
            maskMat = pm.arrayMask;
            break;
          case PendingMask::POLYGONS:
            maskMat = RasterizePolygonsAdvanced(pm.polygons, images_[i].size());
            break;
          case PendingMask::IMAGE:
            pm.src.Materialize();
            maskMat = pm.src.mat;
            break;
          default:
            break;
        }

        if (!maskMat.empty()) {
          if (maskMat.channels() > 1) {
            cv::cvtColor(maskMat, maskMat, cv::COLOR_BGR2GRAY);
          }
          if (maskMat.depth() != CV_8U) {
            cv::Mat tmp;
            maskMat.convertTo(tmp, CV_8U, 255.0);
            maskMat = tmp;
          }
          cv::threshold(maskMat, maskMat, 0, 255, cv::THRESH_BINARY);
          masks_[i] = maskMat;
          maskTags_[i] = pm.tag;
          maskOutputs_[i] = cv::Mat::zeros(canvasHeight_, canvasWidth_, CV_8UC1);
        }
      }
    }
    convertMs_ = (cv::getTickCount() - t0) / cv::getTickFrequency() * 1e3;

    /* ─ SUPER FAST advanced mosaic composition ─ */
    t0 = cv::getTickCount();
    
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
      const cv::Mat srcForEncoding =
            PrepareForEncoding(canvas_, canvasChannel_, outputFormat_);
      encodeMs_ = EncodeToFormat(srcForEncoding, encodedBuf_, outputFormat_, quality_, pngOptimize_);
    } else {
      FinalizeForOutput(canvas_);
    }
    for (auto& m : maskOutputs_) FinalizeForOutput(m);
  }
  
  void OnOK() override {
    Napi::Env env = Env();
    
    // Zero-copy output creation with correct channel format
    Napi::Value jsImg = (outputFormat_ != "raw")
        ? VectorToBuffer(env, std::move(encodedBuf_))       // Zero-copy encoded
        : MatToRawJS(env, canvas_, canvasChannel_);
    
    Napi::Object result = Napi::Object::New(env);
    result.Set("image", jsImg);
    result.Set("timing", MakeTimingJS(env, convertMs_, taskMs_, encodeMs_));

    if (hasMasks_) {
      Napi::Array outMasks = Napi::Array::New(env);
      uint32_t outIdx = 0;
      for (size_t i = 0; i < maskOutputs_.size(); i++) {
        if (maskOutputs_[i].empty()) continue;
        Napi::Object maskObj = Napi::Object::New(env);
        maskObj.Set("mask", MatToRawJS(env, maskOutputs_[i], "GRAY"));
        if (!maskTags_[i].empty()) {
          maskObj.Set("tag", Napi::String::New(env, maskTags_[i]));
        }
        outMasks.Set(outIdx++, maskObj);
      }
      result.Set("masks", outMasks);
    }
    
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

  // Mask input as parsed on the JS thread; materialised in Execute()
  struct PendingMask {
    enum Kind { NONE, ARRAY, POLYGONS, IMAGE };
    Kind kind = NONE;
    std::string tag;
    cv::Mat arrayMask;                                  // from 2D JS array
    std::vector<std::vector<cv::Point2d>> polygons;     // normalized
    ImageSource src;                                    // raw / encoded image
  };
  
  // ULTRA-FAST image processing with transformations
  void ProcessImageFast(const ImageConfig& config) {
    if (config.arrayIndex < 0 || config.arrayIndex >= static_cast<int>(images_.size())) {
      return; // Skip invalid indices
    }
    
    const bool hasMaskForImage = hasMasks_ &&
                                 config.arrayIndex < static_cast<int>(masks_.size()) &&
                                 !masks_[config.arrayIndex].empty();

    // Headers only: the source pixels are never written to. Every transform
    // below writes into a fresh Mat, so no up-front full-image clone is needed.
    cv::Mat img = images_[config.arrayIndex];
    cv::Mat mask = hasMaskForImage ? masks_[config.arrayIndex] : cv::Mat();
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
      
      cv::Mat resized;
      cv::resize(img, resized, cv::Size(targetWidth, targetHeight), 0, 0, cv::INTER_LINEAR);
      img = resized;
      if (hasMaskForImage && !mask.empty()) {
        cv::Mat resizedMask;
        cv::resize(mask, resizedMask, cv::Size(targetWidth, targetHeight), 0, 0, cv::INTER_NEAREST);
        mask = resizedMask;
      }
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
        cv::Mat rotated; cv::rotate(img, rotated, cv::ROTATE_90_COUNTERCLOCKWISE); img = rotated;
      } else if (std::abs(normalizedAngle - 180.0) < eps) {
        cv::Mat rotated; cv::rotate(img, rotated, cv::ROTATE_180); img = rotated;
      } else if (std::abs(normalizedAngle - 270.0) < eps) {
        // 270° counterclockwise = 90° clockwise
        cv::Mat rotated; cv::rotate(img, rotated, cv::ROTATE_90_CLOCKWISE); img = rotated;
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
        
        // Use transparent padding for rotation to allow layering effects
        // This allows background images to show through the rotation padding areas
        cv::Scalar padColor(0, 0, 0, 0); // Transparent black (RGBA)
        
        // Ensure the image has an alpha channel for transparent padding
        // Respect original colorSpace format to prevent channel inversion
        if (img.channels() == 3) {
          cv::Mat withAlpha;
          if (imgChannel == "RGB") {
            cv::cvtColor(img, withAlpha, cv::COLOR_RGB2RGBA);
          } else { // BGR format
            cv::cvtColor(img, withAlpha, cv::COLOR_BGR2BGRA);
          }
          img = withAlpha;
        } else if (img.channels() == 1) {
          cv::Mat withAlpha;
          cv::cvtColor(img, withAlpha, cv::COLOR_GRAY2BGRA);
          img = withAlpha;
        }
        // 4-channel images (RGBA/BGRA) already have alpha - no conversion needed
        
        cv::Mat warped;
        cv::warpAffine(img, warped, rotationMatrix, newSize, 
                      cv::INTER_LINEAR, cv::BORDER_CONSTANT, padColor);
        img = warped;
        if (hasMaskForImage && !mask.empty()) {
          cv::Mat warpedMask;
          cv::warpAffine(mask, warpedMask, rotationMatrix, newSize,
                         cv::INTER_NEAREST, cv::BORDER_CONSTANT, cv::Scalar(0));
          mask = warpedMask;
        }
      }
    }
    
    // Step 3: Place on canvas
    // Update channel format if we converted for rotation
    std::string finalImgChannel = imgChannel;
    if (config.rotation && std::abs(config.rotation) > 1e-3) {
      // After rotation with transparent padding, track correct format
      if (img.channels() == 4) {
        // Preserve original color order for all input formats
        if (imgChannel == "RGB") {
          finalImgChannel = "RGBA";
        } else if (imgChannel == "BGR") {
          finalImgChannel = "BGRA"; 
        } else if (imgChannel == "GRAY") {
          finalImgChannel = "BGRA"; // GRAY converts to BGRA
        }
        // RGBA and BGRA inputs remain unchanged
      }
    }
    
    PlaceImageOnCanvas(img, config, finalImgChannel);
    if (hasMaskForImage && !mask.empty()) {
      PlaceMaskOnCanvas(mask, config);
    }
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
    
    // Alpha-aware image placement for transparent rotation padding
    if (imgToPlace.channels() == 4 && canvasChannel_ == "RGBA") {
      // Both source and destination have alpha - use proper alpha blending
      cv::Mat canvasROI = canvas_(dstROI);
      
      // Row-pointer alpha blending ("over" operator). Same arithmetic as the
      // previous per-pixel .at<>() loop, but without per-element bounds/step
      // computations; fully opaque source pixels are a plain copy.
      const int rows = imgToPlace.rows, cols = imgToPlace.cols;
      cv::parallel_for_(cv::Range(0, rows), [&](const cv::Range& range) {
        for (int y = range.start; y < range.end; ++y) {
          const uchar* s = imgToPlace.ptr<uchar>(y);
          uchar* d = canvasROI.ptr<uchar>(y);
          for (int x = 0; x < cols; ++x, s += 4, d += 4) {
            const uchar sa = s[3];
            if (sa == 0) continue;                       // fully transparent: keep canvas
            if (sa == 255) {                             // fully opaque: overwrite
              d[0] = s[0]; d[1] = s[1]; d[2] = s[2]; d[3] = 255;
              continue;
            }
            const float srcAlpha = sa / 255.0f;
            const float dstAlpha = d[3] / 255.0f;
            // dst = src * srcAlpha + dst * (1 - srcAlpha) * dstAlpha
            const float outAlpha = srcAlpha + dstAlpha * (1.0f - srcAlpha);
            if (outAlpha <= 0.0f) continue;
            const float dstW = dstAlpha * (1.0f - srcAlpha);
            d[0] = static_cast<uchar>((s[0] * srcAlpha + d[0] * dstW) / outAlpha);
            d[1] = static_cast<uchar>((s[1] * srcAlpha + d[1] * dstW) / outAlpha);
            d[2] = static_cast<uchar>((s[2] * srcAlpha + d[2] * dstW) / outAlpha);
            d[3] = static_cast<uchar>(outAlpha * 255.0f);
          }
        }
      });
    } else {
      // Standard copy operation for non-alpha images
      imgToPlace.copyTo(canvas_(dstROI));
    }
  }

  void PlaceMaskOnCanvas(const cv::Mat& mask, const ImageConfig& config) {
    if (mask.empty()) return;
    if (config.arrayIndex < 0 || config.arrayIndex >= static_cast<int>(maskOutputs_.size())) return;

    if (maskOutputs_[config.arrayIndex].empty()) {
      maskOutputs_[config.arrayIndex] = cv::Mat::zeros(canvasHeight_, canvasWidth_, CV_8UC1);
    }

    int x = normalized_ ? static_cast<int>(std::round(config.x * canvasWidth_)) 
                        : static_cast<int>(std::lround(config.x));
    int y = normalized_ ? static_cast<int>(std::round(config.y * canvasHeight_)) 
                        : static_cast<int>(std::lround(config.y));

    if (x >= canvasWidth_ || y >= canvasHeight_) return;
    if (x + mask.cols <= 0 || y + mask.rows <= 0) return;

    int srcX = std::max(0, -x);
    int srcY = std::max(0, -y);
    int dstX = std::max(0, x);
    int dstY = std::max(0, y);

    int width = std::min(mask.cols - srcX, canvasWidth_ - dstX);
    int height = std::min(mask.rows - srcY, canvasHeight_ - dstY);

    if (width <= 0 || height <= 0) return;

    cv::Rect srcROI(srcX, srcY, width, height);
    cv::Rect dstROI(dstX, dstY, width, height);

    cv::Mat srcRegion = mask(srcROI);
    cv::Mat dstRegion = maskOutputs_[config.arrayIndex](dstROI);

    cv::max(dstRegion, srcRegion, dstRegion);
  }
  
  // Member variables
  std::vector<ImageSource> sources_;        // JS inputs (decoded in Execute)
  std::vector<PendingMask> pendingMasks_;   // JS mask inputs (materialised in Execute)
  bool captureFailed_{false};
  bool hasRotation_{false};
  std::vector<cv::Mat> images_;
  std::vector<std::string> imageChannels_;
  std::vector<ImageConfig> imageConfigs_;
  cv::Mat canvas_;
  std::string canvasChannel_;
  std::vector<cv::Mat> masks_;
  std::vector<std::string> maskTags_;
  std::vector<cv::Mat> maskOutputs_;
  bool hasMasks_{false};
  
  int canvasWidth_, canvasHeight_;
  std::string backgroundColor_;
  bool normalized_;
  std::string outputFormat_;
  int quality_;
  bool pngOptimize_;
  
  double convertMs_{0.0}, taskMs_{0.0}, encodeMs_{0.0};
  std::vector<uchar> encodedBuf_;
};

/*──────── BINDING: advancedMosaic(imagesArray, width, height, bgColor, imageConfigs, normalized, [options|outputFormat], ...) ─*/
Napi::Value AdvancedMosaic(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  
  if (info.Length() < 7 || !info[info.Length() - 1].IsFunction()) {
    return Napi::TypeError::New(env,
      "advancedMosaic(imagesArray, width, height, bgColor, imageConfigs, normalized, [options|outputFormat], [quality], [pngOptimize], callback)")
      .Value();
  }
  
  // Parse required parameters
  int i = 0;
  Napi::Array imagesArray = info[i++].As<Napi::Array>();
  int canvasWidth = info[i++].As<Napi::Number>().Int32Value();
  int canvasHeight = info[i++].As<Napi::Number>().Int32Value();
  std::string backgroundColor = info[i++].As<Napi::String>().Utf8Value();
  Napi::Array imageConfigs = info[i++].As<Napi::Array>();
  bool normalized = info[i++].As<Napi::Boolean>().Value();
  
  // Optional parameters (either legacy positional or options object)
  std::string outputFormat = "raw";
  int quality = 90;
  bool pngOptimize = false;
  bool hasMasks = false;
  Napi::Array masksArray;

  // If next argument is an object (not array/function), treat it as options
  if (info.Length() - i > 1 && info[i].IsObject() && !info[i].IsArray() && !info[i].IsFunction()) {
    Napi::Object opts = info[i++].As<Napi::Object>();
    if (opts.Has("outputFormat")) outputFormat = opts.Get("outputFormat").As<Napi::String>().Utf8Value();
    if (opts.Has("quality")) quality = opts.Get("quality").As<Napi::Number>().Int32Value();
    if (opts.Has("pngOptimize")) pngOptimize = opts.Get("pngOptimize").As<Napi::Boolean>().Value();
    if (opts.Has("masks") && opts.Get("masks").IsArray()) {
      masksArray = opts.Get("masks").As<Napi::Array>();
      hasMasks = true;
    }
  }
  
  // Legacy positional parsing
  if (info.Length() - i >= 2) {
    outputFormat = info[i++].As<Napi::String>().Utf8Value();
  }
  if (info.Length() - i >= 2) {
    quality = info[i++].As<Napi::Number>().Int32Value();
  }
  if (info.Length() - i >= 2) {
    pngOptimize = info[i++].As<Napi::Boolean>().Value();
  }
  
  Napi::Function callback = info[info.Length() - 1].As<Napi::Function>();
  
  // Validate canvas dimensions
  if (canvasWidth <= 0 || canvasHeight <= 0) {
    return Napi::TypeError::New(env, "Canvas dimensions must be positive").Value();
  }
  
  // Launch ULTRA-FAST worker
  (new AdvancedMosaicWorker(callback, imagesArray, canvasWidth, canvasHeight, 
                           backgroundColor, imageConfigs, normalized, outputFormat, quality, pngOptimize,
                           hasMasks, masksArray))->Queue();
  
  return env.Undefined();
}
