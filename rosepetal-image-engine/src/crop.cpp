// ───────── src/crop.cpp ───────────────────────────────────────────────
#include <napi.h>
#include <opencv2/opencv.hpp>
#include <cmath>
#include "utils.h"          // CaptureImage, PrepareForEncoding, EncodeToFormat…

/*────────────────────────── Worker ───────────────────────────────────*/
class CropWorker : public Napi::AsyncWorker {
public:
  CropWorker(Napi::Function cb,
             const Napi::Value& imgVal,
             double x,double y,double width,double height,
             bool normalized,std::string outputFormat,int quality = 90,bool pngOptimize = false)
    : Napi::AsyncWorker(cb),
      x_(x),y_(y),width_(width),height_(height),
      normalized_(normalized),outputFormat_(std::move(outputFormat)),quality_(quality),pngOptimize_(pngOptimize)
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

    /* ─ convertMs: decode (encoded inputs only), worker thread ─ */
    int64 t0 = cv::getTickCount();
    src_.Materialize();
    input_   = src_.mat;
    channel_ = src_.colorSpace;
    convertMs_ = (cv::getTickCount()-t0)/cv::getTickFrequency()*1e3;

    /* ─ taskMs (recorte) ─ */
    t0 = cv::getTickCount();

    const int W=input_.cols, H=input_.rows;
    int x = normalized_? int(std::round(x_*W)) : int(std::lround(x_));
    int y = normalized_? int(std::round(y_*H)) : int(std::lround(y_));
    int width = normalized_? int(std::round(width_*W)) : int(std::lround(width_));
    int height = normalized_? int(std::round(height_*H)) : int(std::lround(height_));

    // Clamp position and dimensions to valid ranges
    x = std::clamp(x, 0, W-1);
    y = std::clamp(y, 0, H-1);
    width = std::clamp(width, 1, W-x);   // Ensure width doesn't exceed image boundary
    height = std::clamp(height, 1, H-y); // Ensure height doesn't exceed image boundary

    result_ = input_(cv::Rect(x, y, width, height));

    taskMs_ = (cv::getTickCount()-t0)/cv::getTickFrequency()*1e3;

    /* ─ Multi-format encoding (encodeMs) ─ */
    if(outputFormat_ != "raw"){
      const cv::Mat srcForEncoding =
            PrepareForEncoding(result_, channel_, outputFormat_);
      encodeMs_ = EncodeToFormat(srcForEncoding, encodedBuf_, outputFormat_, quality_, pngOptimize_);
    } else {
      FinalizeForOutput(result_);      // ROI → contiguous owned copy (worker thread)
    }
  }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::Value jsImg = (outputFormat_ != "raw")
        ? VectorToBuffer(env,std::move(encodedBuf_))        // 0-copy
        : MatToRawJS(env,result_,channel_);

    Napi::Object out = Napi::Object::New(env);
    out.Set("image",  jsImg);
    out.Set("timing", MakeTimingJS(env,convertMs_,taskMs_,encodeMs_));
    Callback().Call({ env.Null(), out });
  }

  void OnError(const Napi::Error& e) override {
    Callback().Call({ e.Value(), Env().Null() });
  }

private:
  ImageSource src_;
  cv::Mat input_, result_;
  double x_, y_, width_, height_;
  bool   normalized_;
  std::string outputFormat_;
  int quality_;
  bool pngOptimize_;
  std::string channel_;
  bool captureFailed_ = false;

  double convertMs_{0.0}, taskMs_{0.0}, encodeMs_{0.0};
  std::vector<uchar> encodedBuf_;
};

/*──────── binding: crop(image,x,y,width,height,normalized,[outputFormat],[quality],cb) ─*/
Napi::Value Crop(const Napi::CallbackInfo& info)
{
  Napi::Env env = info.Env();
  if(info.Length()<7||info.Length()>10||!info[info.Length()-1].IsFunction())
    return Napi::TypeError::New(env,
      "crop(image,x,y,width,height,normalized,[outputFormat],[quality],[pngOptimize],callback)").Value();

  int i=0;
  Napi::Value img = info[i++];
  double x = info[i++].As<Napi::Number>(),
         y = info[i++].As<Napi::Number>(),
         width = info[i++].As<Napi::Number>(),
         height = info[i++].As<Napi::Number>();
  bool norm = info[i++].As<Napi::Boolean>();
  
  // Handle parameters
  std::string outputFormat = "raw";
  int quality = 90;
  bool pngOptimize = false;
  
  if (info.Length() >= 8) {
    outputFormat = info[i++].As<Napi::String>().Utf8Value();
  }
  
  if (info.Length() >= 9) {
    quality = info[i++].As<Napi::Number>().Int32Value();
  }
  
  if (info.Length() == 10) {
    pngOptimize = info[i++].As<Napi::Boolean>().Value();
  }
  
  Napi::Function cb = info[i].As<Napi::Function>();

  (new CropWorker(cb,img,x,y,width,height,norm,outputFormat,quality,pngOptimize))->Queue();
  return env.Undefined();
}
