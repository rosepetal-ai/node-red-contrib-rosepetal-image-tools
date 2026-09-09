#include <napi.h>
#include <opencv2/opencv.hpp>
#include "utils.h"

// Helper function to create binary mask from polygon coordinates
cv::Mat CreatePolygonMask(const std::vector<cv::Point2f>& polygon, cv::Size imageSize) {
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


/*------------------------------------------------------------------------*/
class AddMaskWorker final : public Napi::AsyncWorker {
public:
  AddMaskWorker(Napi::Function cb,
                const Napi::Value& jsImg,
                const Napi::Array& polygonArray,
                double maskStrength,
                int fillR, int fillG, int fillB,
                std::string outputFormat,
                int quality = 90,
                bool pngOptimize = false)
    : Napi::AsyncWorker(cb),
      maskStrength(maskStrength),
      fillR(fillR), fillG(fillG), fillB(fillB),
      outputFormat(std::move(outputFormat)),
      quality(quality), pngOptimize(pngOptimize)
  {
    // JS thread: metadata + persistent reference only (no decode, no pixels)
    try {
      src_ = CaptureImage(jsImg);
    } catch (const Napi::Error& e) {
      captureFailed_ = true; SetError(e.Message());
    } catch (const std::exception& e) {
      captureFailed_ = true; SetError(e.what());
    }

    // Parse polygon coordinates from JavaScript array
    polygon.reserve(polygonArray.Length());
    for (size_t i = 0; i < polygonArray.Length(); i++) {
      Napi::Array point = polygonArray.Get(i).As<Napi::Array>();
      if (point.Length() >= 2) {
        float x = point.Get(0u).As<Napi::Number>().FloatValue();
        float y = point.Get(1u).As<Napi::Number>().FloatValue();
        polygon.emplace_back(x, y);
      }
    }
    
  }

protected:
  void Execute() override {
    if (captureFailed_) return;

    // Decode (encoded inputs only) on the worker thread
    int64 t0 = cv::getTickCount();
    src_.Materialize();
    const cv::Mat& imageMat = src_.mat;
    imageFormat = src_.colorSpace;
    // For polygon-based masking, output format matches image format
    outputChannel = imageFormat;
    convertMs = (cv::getTickCount() - t0) / cv::getTickFrequency() * 1e3;

    t0 = cv::getTickCount();
    
    // Convert image to target format
    cv::Mat img = ConvertToTargetFormatShared(imageMat, imageFormat, outputChannel);
    
    // Generate binary mask from polygon coordinates
    cv::Mat binaryMask = CreatePolygonMask(polygon, img.size());
    
    // Convert image and mask to float for precise blending
    cv::Mat imgFloat;
    img.convertTo(imgFloat, CV_32F, 1.0/255.0);
    
    // Convert binary mask to float weights (0.0 to 1.0)
    cv::Mat maskWeights;
    binaryMask.convertTo(maskWeights, CV_32F, 1.0/255.0);
    
    // Apply mask strength to weights
    maskWeights *= maskStrength;
    
    // Create solid color image with fill color
    cv::Mat fillColorImg;
    if (imgFloat.channels() == 1) {
      // Grayscale: use average of RGB values
      float grayValue = (fillR + fillG + fillB) / (3.0f * 255.0f);
      fillColorImg = cv::Mat::ones(img.size(), CV_32F) * grayValue;
    } else if (imgFloat.channels() == 3) {
      // Color image - respect the color space format
      fillColorImg = cv::Mat::ones(img.size(), CV_32FC3);
      if (outputChannel == "RGB" || outputChannel == "RGBA") {
        // RGB format: R, G, B order
        fillColorImg.setTo(cv::Scalar(fillR/255.0f, fillG/255.0f, fillB/255.0f));
      } else {
        // BGR format: B, G, R order (OpenCV default)
        fillColorImg.setTo(cv::Scalar(fillB/255.0f, fillG/255.0f, fillR/255.0f));
      }
    } else if (imgFloat.channels() == 4) {
      // Color image with alpha
      fillColorImg = cv::Mat::ones(img.size(), CV_32FC4);
      if (outputChannel == "RGBA") {
        // RGBA format: R, G, B, A order
        fillColorImg.setTo(cv::Scalar(fillR/255.0f, fillG/255.0f, fillB/255.0f, 1.0f));
      } else {
        // BGRA format: B, G, R, A order (OpenCV default)
        fillColorImg.setTo(cv::Scalar(fillB/255.0f, fillG/255.0f, fillR/255.0f, 1.0f));
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
    
    // Weighted blending: result = image * (1 - blend_weights) + fill_color * blend_weights
    cv::Mat resultFloat;
    cv::Mat inverseWeights;
    cv::subtract(cv::Scalar::all(1.0), blendWeights, inverseWeights);
    
    // Element-wise multiplication and addition
    cv::Mat term1, term2;
    cv::multiply(imgFloat, inverseWeights, term1);
    cv::multiply(fillColorImg, blendWeights, term2);
    cv::add(term1, term2, resultFloat);
    
    // Convert back to 8-bit
    resultFloat.convertTo(result, CV_8U, 255.0);
    
    taskMs = (cv::getTickCount() - t0) / cv::getTickFrequency() * 1e3;

    // Multi-format encoding if needed
    if (outputFormat != "raw") {
      cv::Mat tmp = PrepareForEncoding(result, outputChannel, outputFormat);
      encodeMs = EncodeToFormat(tmp, encodedBuf, outputFormat, quality, pngOptimize);
    } else {
      FinalizeForOutput(result);
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

  void OnError(const Napi::Error& e) override {
    Callback().Call({ e.Value(), Env().Null() });
  }

private:
  ImageSource src_;
  bool captureFailed_ = false;
  cv::Mat result;
  std::string imageFormat, outputChannel;
  std::vector<cv::Point2f> polygon;
  double maskStrength;
  int fillR, fillG, fillB;
  std::string outputFormat;
  int quality;
  bool pngOptimize;
  double convertMs = 0, taskMs = 0, encodeMs = 0;
  std::vector<uchar> encodedBuf;
};

/*------------------------------------------------------------------------*/
Napi::Value AddMask(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  
  // Fast parameter validation: image, polygon, maskStrength, fillR, fillG, fillB, [outputFormat], [quality], [pngOptimize], callback
  if (info.Length() < 7 || info.Length() > 10 || !info[info.Length() - 1].IsFunction()) {
    Napi::TypeError::New(env, "addMask(image, polygon, maskStrength, fillR, fillG, fillB, [outputFormat], [quality], [pngOptimize], callback)")
      .ThrowAsJavaScriptException();
    return env.Null();
  }

  // Extract required parameters
  Napi::Value jsImg = info[0];
  Napi::Array polygonArray = info[1].As<Napi::Array>();
  double maskStrength = info[2].As<Napi::Number>().DoubleValue();
  int fillR = info[3].As<Napi::Number>().Int32Value();
  int fillG = info[4].As<Napi::Number>().Int32Value();
  int fillB = info[5].As<Napi::Number>().Int32Value();
  
  // Clamp values to valid ranges
  maskStrength = std::max(0.0, std::min(1.0, maskStrength));
  fillR = std::max(0, std::min(255, fillR));
  fillG = std::max(0, std::min(255, fillG));
  fillB = std::max(0, std::min(255, fillB));
  
  // Handle optional parameters
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

  // Create and queue worker
  (new AddMaskWorker(
    info[cbIdx].As<Napi::Function>(), 
    jsImg, polygonArray, maskStrength, 
    fillR, fillG, fillB,
    outputFormat, quality, pngOptimize
  ))->Queue();
  
  return env.Undefined();
}
