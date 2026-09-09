// ───────── src/color-convert.cpp ───────────────────────────────────────────
#include <napi.h>
#include <opencv2/opencv.hpp>
#include <chrono>
#include <string>
#include <unordered_map>
#include "utils.h"

// ──────────────────────────────── Lookup key helper
static inline std::string MakeKey(const std::string& src, const std::string& dst) {
  return src + ">" + dst;
}

// ──────────────────────────────── Complete conversion table (20 paths)
static const std::unordered_map<std::string, int>& ConversionTable() {
  static const std::unordered_map<std::string, int> table = {
    // GRAY →
    { MakeKey("GRAY","BGR"),  cv::COLOR_GRAY2BGR  },
    { MakeKey("GRAY","RGB"),  cv::COLOR_GRAY2RGB  },
    { MakeKey("GRAY","BGRA"), cv::COLOR_GRAY2BGRA },
    { MakeKey("GRAY","RGBA"), cv::COLOR_GRAY2RGBA },
    // BGR →
    { MakeKey("BGR","GRAY"),  cv::COLOR_BGR2GRAY  },
    { MakeKey("BGR","RGB"),   cv::COLOR_BGR2RGB   },
    { MakeKey("BGR","BGRA"),  cv::COLOR_BGR2BGRA  },
    { MakeKey("BGR","RGBA"),  cv::COLOR_BGR2RGBA  },
    // RGB →
    { MakeKey("RGB","GRAY"),  cv::COLOR_RGB2GRAY  },
    { MakeKey("RGB","BGR"),   cv::COLOR_RGB2BGR   },
    { MakeKey("RGB","BGRA"),  cv::COLOR_RGB2BGRA  },
    { MakeKey("RGB","RGBA"),  cv::COLOR_RGB2RGBA  },
    // BGRA →
    { MakeKey("BGRA","GRAY"), cv::COLOR_BGRA2GRAY },
    { MakeKey("BGRA","BGR"),  cv::COLOR_BGRA2BGR  },
    { MakeKey("BGRA","RGB"),  cv::COLOR_BGRA2RGB  },
    { MakeKey("BGRA","RGBA"), cv::COLOR_BGRA2RGBA },
    // RGBA →
    { MakeKey("RGBA","GRAY"), cv::COLOR_RGBA2GRAY },
    { MakeKey("RGBA","BGR"),  cv::COLOR_RGBA2BGR  },
    { MakeKey("RGBA","RGB"),  cv::COLOR_RGBA2RGB  },
    { MakeKey("RGBA","BGRA"), cv::COLOR_RGBA2BGRA },
  };
  return table;
}

// ──────────────────────────────── Worker
class ColorConvertWorker : public Napi::AsyncWorker {
public:
  ColorConvertWorker(Napi::Function& cb,
                   const Napi::Value& imgVal,
                   std::string targetColorSpace,
                   std::string outputFormat,
                   int quality = 90,
                   bool pngOptimize = false)
    : Napi::AsyncWorker(cb),
      targetCS(std::move(targetColorSpace)),
      outputFormat(std::move(outputFormat)),
      quality(quality),
      pngOptimize(pngOptimize)
  {
    // JS thread: metadata + persistent reference only (no decode, no pixels)
    try {
      src_ = CaptureImage(imgVal);
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
      // Decode (encoded inputs only) on the worker thread
      auto tc = std::chrono::steady_clock::now();
      src_.Materialize();
      inputMat = src_.mat;
      sourceCS = src_.colorSpace;
      convertMs = std::chrono::duration<double, std::milli>(
                    std::chrono::steady_clock::now() - tc).count();

      auto t0 = std::chrono::steady_clock::now();

      // Identity fast-path: same source and target
      if (sourceCS == targetCS) {
        resultMat = inputMat;
      } else {
        const std::string key = MakeKey(sourceCS, targetCS);
        const auto& table = ConversionTable();
        auto it = table.find(key);
        if (it == table.end()) {
          SetError("Unsupported color space conversion: " + sourceCS + " -> " + targetCS);
          return;
        }
        cv::cvtColor(inputMat, resultMat, it->second);
      }

      taskMs = std::chrono::duration<double, std::milli>(
                 std::chrono::steady_clock::now() - t0).count();

      // Multi-format encoding
      if (outputFormat != "raw") {
        const cv::Mat srcForEncoding =
              PrepareForEncoding(resultMat, targetCS, outputFormat);
        encodeMs = EncodeToFormat(srcForEncoding, encodedBuf, outputFormat, quality, pngOptimize);
      } else {
        FinalizeForOutput(resultMat);   // identity alias → owned copy (worker thread)
      }
    } catch (const std::exception& e) { SetError(e.what()); }
  }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::Value jsImg = (outputFormat != "raw")
        ? VectorToBuffer(env, std::move(encodedBuf))
        : MatToRawJS(env, resultMat, targetCS);

    Napi::Object res = Napi::Object::New(env);
    res.Set("image",  jsImg);
    res.Set("timing", MakeTimingJS(env, convertMs, taskMs, encodeMs));
    Callback().Call({ env.Null(), res });
  }

  void OnError(const Napi::Error& e) override {
    Callback().Call({ e.Value(), Env().Null() });
  }

private:
  ImageSource src_;
  cv::Mat inputMat, resultMat;
  std::string sourceCS;
  std::string targetCS;
  std::string outputFormat;
  int quality;
  bool pngOptimize;
  bool captureFailed_ = false;

  double convertMs = 0.0;
  double taskMs   = 0.0;
  double encodeMs = 0.0;
  std::vector<uchar> encodedBuf;
};

// ───────── Binding JS → C++ ────────────────────────────────────────────
// colorConvert(image, targetColorSpace, outputFormat, quality, pngOptimize, callback)
Napi::Value ColorConvert(const Napi::CallbackInfo& info)
{
  Napi::Env env = info.Env();
  if (info.Length() < 3 || info.Length() > 6 ||
      !info[info.Length()-1].IsFunction())
    return Napi::TypeError::New(env,
      "colorConvert(image, targetColorSpace, [outputFormat], [quality], [pngOptimize], callback)").Value();

  int i = 0;
  Napi::Value img = info[i++];
  std::string targetColorSpace = info[i++].As<Napi::String>().Utf8Value();

  // Handle optional parameters
  std::string outputFormat = "raw";
  int quality = 90;
  bool pngOptimize = false;

  if (info.Length() - i >= 2) {
    outputFormat = info[i++].As<Napi::String>().Utf8Value();
  }

  if (info.Length() - i >= 2) {
    quality = info[i++].As<Napi::Number>().Int32Value();
  }

  if (info.Length() - i >= 2) {
    pngOptimize = info[i++].As<Napi::Boolean>().Value();
  }

  Napi::Function cb = info[i].As<Napi::Function>();

  auto* worker = new ColorConvertWorker(
      cb,
      img,
      targetColorSpace,
      outputFormat,
      quality,
      pngOptimize);
  worker->Queue();
  return env.Undefined();
}
