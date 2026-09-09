// Fichero: src/resize.cpp

#include <napi.h>
#include <opencv2/opencv.hpp>
#include <chrono>
#include <cstring>
#include <string>
#include <vector>
#include <cmath>
#include <utility>  
#include <limits> 
#include <cstdlib>
#include "utils.h"

class ResizeWorker : public Napi::AsyncWorker {
public:
ResizeWorker(Napi::Function& callback,
  const Napi::Value& inputImage,
  std::string widthMode,  double widthValue,
  std::string heightMode, double heightValue,
  std::string outputFormat,
  int quality = 90,
  bool pngOptimize = false)
  : Napi::AsyncWorker(callback),
  widthMode(std::move(widthMode)),   widthValue(widthValue),
  heightMode(std::move(heightMode)), heightValue(heightValue),
  outputFormat(std::move(outputFormat)), quality(quality), pngOptimize(pngOptimize){

    // JS thread: metadata + persistent reference only (no decode, no pixels)
    try {
      src_ = CaptureImage(inputImage);
    } catch (const Napi::Error& e) {
      captureFailed_ = true; SetError(e.Message());
    } catch (const std::exception& e) {
      captureFailed_ = true; SetError(e.what());
    }
  }

protected:
  void Execute() override {
    if (captureFailed_) return;
    try {
        // --- 4.0 Decode (encoded inputs only) on the worker thread ---
        {
          auto tc0 = std::chrono::steady_clock::now();
          src_.Materialize();
          inputMat = src_.mat;
          channelOrder = src_.colorSpace;
          auto tc1 = std::chrono::steady_clock::now();
          convertMs = std::chrono::duration<double, std::milli>(tc1 - tc0).count();
        }

        // --- 4.1 Calcular ancho/alto objetivo --------------------------
        auto safeRoundToInt = [](double value) -> int {
          if (!std::isfinite(value)) {
            throw std::runtime_error("Dimension must be finite (got " + std::to_string(value) + ")");
          }
          constexpr double kMinInt = static_cast<double>(std::numeric_limits<int>::min());
          constexpr double kMaxInt = static_cast<double>(std::numeric_limits<int>::max());
          if (value < kMinInt || value > kMaxInt) {
            throw std::runtime_error("Dimension out of int range (got " + std::to_string(value) + ")");
          }
          const long long rounded = std::llround(value);
          if (rounded < std::numeric_limits<int>::min() || rounded > std::numeric_limits<int>::max()) {
            throw std::runtime_error("Dimension out of int range (got " + std::to_string(value) + ")");
          }
          return static_cast<int>(rounded);
        };

        auto calcDim = [&](int orig, const std::string& mode, double val) -> int {
          if (std::isnan(val)) return 0;  // Auto
          if (!std::isfinite(val)) {
            throw std::runtime_error("Dimension value must be finite (got " + std::to_string(val) + ")");
          }
          const double computed = (mode == "multiply")
            ? static_cast<double>(orig) * val
            : val;
          try {
            return safeRoundToInt(computed);
          } catch (const std::exception& e) {
            throw std::runtime_error(
              "Dimension calc failed (mode=" + mode +
              ", orig=" + std::to_string(orig) +
              ", val=" + std::to_string(val) +
              "): " + e.what()
            );
          }
        };
      
        try {
          targetWidth = calcDim(inputMat.cols, widthMode, widthValue);
        } catch (const std::exception& e) {
          throw std::runtime_error("Invalid target width: " + std::string(e.what()));
        }
        try {
          targetHeight = calcDim(inputMat.rows, heightMode, heightValue);
        } catch (const std::exception& e) {
          throw std::runtime_error("Invalid target height: " + std::string(e.what()));
        }

        if (!targetWidth && !targetHeight)
            throw std::runtime_error("Both dimensions are Auto");

        if (!targetWidth)
            targetWidth  = safeRoundToInt(targetHeight *
                        (double)inputMat.cols / inputMat.rows);
        if (!targetHeight)
            targetHeight = safeRoundToInt(targetWidth  *
                        (double)inputMat.rows / inputMat.cols);

        if (targetWidth <= 0 || targetHeight <= 0) {
            throw std::runtime_error(
              "Target dimensions must be positive (got " +
              std::to_string(targetWidth) + "x" +
              std::to_string(targetHeight) + ")"
            );
        }

        // Guardrail against pathological allocations (misconfig values can overflow to huge sizes).
        // Default: 4 GiB max output buffer; override via ROSEPETAL_MAX_RESIZE_BYTES.
        static const uint64_t maxResizeBytes = []() -> uint64_t {
          const char* env = std::getenv("ROSEPETAL_MAX_RESIZE_BYTES");
          if (!env || !*env) {
            return 4ULL * 1024ULL * 1024ULL * 1024ULL;
          }
          try {
            const unsigned long long parsed = std::stoull(env);
            return parsed > 0 ? static_cast<uint64_t>(parsed)
                              : 4ULL * 1024ULL * 1024ULL * 1024ULL;
          } catch (...) {
            return 4ULL * 1024ULL * 1024ULL * 1024ULL;
          }
        }();

        const uint64_t outPixels = static_cast<uint64_t>(targetWidth) * static_cast<uint64_t>(targetHeight);
        const uint64_t outBytes = outPixels * static_cast<uint64_t>(inputMat.elemSize());
        if (outBytes > maxResizeBytes) {
          throw std::runtime_error(
            "Resize to " + std::to_string(targetWidth) + "x" + std::to_string(targetHeight) +
            " would allocate too much memory (" + std::to_string(outBytes) + " bytes). " +
            "Check width/height values or increase ROSEPETAL_MAX_RESIZE_BYTES."
          );
        }

        // --- 4.2 Redimensionar ----------------------------------------
        auto t0 = std::chrono::steady_clock::now();
        try {
          cv::resize(inputMat, resultMat,
                    cv::Size(targetWidth, targetHeight),
                    0, 0, cv::INTER_LINEAR);
        } catch (const cv::Exception& e) {
          const auto inStep = static_cast<unsigned long long>(inputMat.step);
          const auto inElemSize = static_cast<unsigned long long>(inputMat.elemSize());
          throw std::runtime_error(
            std::string("cv::resize failed for ") +
            std::to_string(inputMat.cols) + "x" + std::to_string(inputMat.rows) +
            " type=" + std::to_string(inputMat.type()) +
            " channels=" + std::to_string(inputMat.channels()) +
            " elemSize=" + std::to_string(inElemSize) +
            " step=" + std::to_string(inStep) +
            " -> " + std::to_string(targetWidth) + "x" + std::to_string(targetHeight) +
            ": " + e.what()
          );
        }
        auto t1 = std::chrono::steady_clock::now();
        taskMs = std::chrono::duration<double, std::milli>(t1 - t0).count();

        // --- 4.3 Multi-format encoding -----------------------------
        if (outputFormat != "raw") {
          const cv::Mat srcForEncoding =
                PrepareForEncoding(resultMat, channelOrder, outputFormat);
          encodeMs = EncodeToFormat(srcForEncoding, encodedBuf, outputFormat, quality, pngOptimize);
        } else {
          FinalizeForOutput(resultMat);
        }
    } catch (const std::exception& e) {
        SetError(e.what());
    }
  }


  // Fichero: src/resize.cpp (OnOK corregido y final)

  void OnOK() override {
    Napi::Env env = Env();
    Napi::Value imageResult; // Usamos un Napi::Value para guardar el resultado de la imagen

    // --- Lógica de la Imagen ---
    if (outputFormat != "raw") {
        imageResult = VectorToBuffer(env, std::move(encodedBuf));
    } else {
        // Return raw image object using new format
        imageResult = MatToRawJS(env, resultMat, channelOrder);
    }

    // --- Lógica de Tiempos (siempre se añade) ---
    Napi::Object timingObj = Napi::Object::New(env);
    timingObj.Set("convertMs", Napi::Number::New(env, convertMs));
    timingObj.Set("taskMs",   Napi::Number::New(env, taskMs));
    timingObj.Set("encodeMs", Napi::Number::New(env, encodeMs));

    // --- Objeto Final (siempre tiene la misma estructura) ---
    Napi::Object finalResult = Napi::Object::New(env);
    finalResult.Set("image",  imageResult); // Contiene el Buffer JPG o el Objeto Raw
    finalResult.Set("timing", timingObj);

    Callback().Call({ env.Null(), finalResult });
  }

  void OnError(const Napi::Error& e) override {
    Callback().Call({ e.Value(), Env().Null() });
  }

private:
  ImageSource src_;
  bool captureFailed_ = false;
  cv::Mat inputMat, resultMat;
  int targetWidth = 0;
  int targetHeight = 0;
  std::string widthMode;  
  std::string heightMode;
  double widthValue  = std::numeric_limits<double>::quiet_NaN();
  double heightValue = std::numeric_limits<double>::quiet_NaN();


  std::string channelOrder;

  double convertMs = 0.0;
  double taskMs    = 0.0;

  std::string outputFormat;
  int quality;
  bool pngOptimize;
  std::vector<uchar> encodedBuf;
  double encodeMs = 0.0;
};

Napi::Value Resize(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

    if (info.Length() < 6 || info.Length() > 9 || !info[info.Length() - 1].IsFunction()) {
      Napi::TypeError::New(env,
        "Expected (image, widthMode, widthVal, heightMode, heightVal, [outputFormat], [quality], [pngOptimize], callback)")
        .ThrowAsJavaScriptException();
      return env.Null();
  }

  std::string outputFormat = "raw";
  int quality = 90;
  bool pngOptimize = false;
  size_t cbIndex = 5;

  // Handle parameters
  if (info.Length() == 7) {
    outputFormat = info[5].As<Napi::String>().Utf8Value();
    cbIndex = 6;
  } else if (info.Length() == 8) {
    outputFormat = info[5].As<Napi::String>().Utf8Value();
    quality = info[6].As<Napi::Number>().Int32Value();
    cbIndex = 7;
  } else if (info.Length() == 9) {
    outputFormat = info[5].As<Napi::String>().Utf8Value();
    quality = info[6].As<Napi::Number>().Int32Value();
    pngOptimize = info[7].As<Napi::Boolean>().Value();
    cbIndex = 8;
  }

  Napi::Function cb = info[cbIndex].As<Napi::Function>();

  auto* worker = new ResizeWorker(
      cb,
      info[0],                                    // image
      info[1].As<Napi::String>().Utf8Value(),     // widthMode
      info[2].As<Napi::Number>().DoubleValue(),   // widthVal
      info[3].As<Napi::String>().Utf8Value(),     // heightMode
      info[4].As<Napi::Number>().DoubleValue(),   // heightVal
      outputFormat,                               // outputFormat
      quality,                                    // quality
      pngOptimize);                               // pngOptimize

  worker->Queue();
  return env.Undefined();
}
