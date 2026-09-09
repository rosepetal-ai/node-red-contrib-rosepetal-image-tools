// ───────── src/padding.cpp (ultra‑optimised + pad colour) ─────────
#include <napi.h>
#include <opencv2/opencv.hpp>
#include "utils.h"

/*------------------------------------------------------------------------*/
class PaddingWorker final : public Napi::AsyncWorker {
public:
  PaddingWorker(Napi::Function cb,
                const Napi::Value& imgVal,
                int top,int bottom,int left,int right,
                cv::Scalar padRGB,
                std::string outputFormat,
                int quality = 90,
                bool pngOptimize = false)
    : Napi::AsyncWorker(cb),
      t_(top),b_(bottom),l_(left),r_(right),
      padColorRGB(padRGB),
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

    /* convertMs — decode on the worker thread (raw input is zero‑copy) */
    int64 t0=cv::getTickCount();
    src_.Materialize();
    const cv::Mat& srcMat = src_.mat;
    channel_ = src_.colorSpace;
    convertMs_=(cv::getTickCount()-t0)/cv::getTickFrequency()*1e3;

    padClrImg=padColorRGB;
    if(channel_=="RGB"||channel_=="RGBA") std::swap(padClrImg[0],padClrImg[2]);

    t0=cv::getTickCount();
    cv::copyMakeBorder(srcMat,dst_,t_,b_,l_,r_,cv::BORDER_CONSTANT,padClrImg);
    taskMs_=(cv::getTickCount()-t0)/cv::getTickFrequency()*1e3;

    if (outputFormat != "raw") {
      const cv::Mat srcForEncoding =
            PrepareForEncoding(dst_, channel_, outputFormat);
      encodeMs_ = EncodeToFormat(srcForEncoding, encodedBuf_, outputFormat, quality, pngOptimize);
    } else {
      FinalizeForOutput(dst_);
    }
  }

  void OnOK() override {
    Napi::Env env=Env();
    Napi::Value jsImg=(outputFormat != "raw")?VectorToBuffer(env,std::move(encodedBuf_))
                                             :MatToRawJS(env,dst_,channel_);

    Napi::Object res=Napi::Object::New(env);
    res.Set("image",jsImg);
    res.Set("timing",MakeTimingJS(env,convertMs_,taskMs_,encodeMs_));
    Callback().Call({env.Null(),res});
  }

  void OnError(const Napi::Error& e) override {
    Callback().Call({ e.Value(), Env().Null() });
  }

private:
  ImageSource src_;
  cv::Mat dst_;
  int t_,b_,l_,r_;
  cv::Scalar padColorRGB,padClrImg;
  std::string channel_;
  std::string outputFormat;
  int quality;
  bool pngOptimize;
  bool captureFailed_ = false;

  double convertMs_{0},taskMs_{0},encodeMs_{0};
  std::vector<uchar> encodedBuf_;
};

/*──────── binding: padding(img,top,bottom,left,right,padHex,[outputFormat],[quality],cb) ─*/
Napi::Value Padding(const Napi::CallbackInfo& info){
  Napi::Env env=info.Env();
  if(info.Length()<7||info.Length()>10||!info[info.Length()-1].IsFunction())
    return Napi::TypeError::New(env,
      "padding(image,top,bottom,left,right,padHex,[outputFormat],[quality],[pngOptimize],callback)").Value();

  int i=0;
  Napi::Value img=info[i++];
  int top   =info[i++].As<Napi::Number>();
  int bottom=info[i++].As<Napi::Number>();
  int left  =info[i++].As<Napi::Number>();
  int right =info[i++].As<Napi::Number>();
  cv::Scalar pad=ParseColor(info[i++].As<Napi::String>());

  // Handle parameters
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
  
  Napi::Function cb=info[i].As<Napi::Function>();

  (new PaddingWorker(cb,img,top,bottom,left,right,pad,outputFormat,quality,pngOptimize))->Queue();
  return env.Undefined();
}
