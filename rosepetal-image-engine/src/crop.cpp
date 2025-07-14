// ───────── src/crop.cpp ───────────────────────────────────────────────
#include <napi.h>
#include <opencv2/opencv.hpp>
#include <cmath>
#include "utils.h"          // ConvertToMat, ToBgrForJpg, EncodeToJpgFast…

/*────────────────────────── Worker ───────────────────────────────────*/
class CropWorker : public Napi::AsyncWorker {
public:
  CropWorker(Napi::Function cb,
             const Napi::Value& imgVal,
             double x1,double y1,double x2,double y2,
             bool normalized,bool encJpg)
    : Napi::AsyncWorker(cb),
      x1_(x1),y1_(y1),x2_(x2),y2_(y2),
      normalized_(normalized),encJpg_(encJpg)
  {
    /* ─ medir convertMs ─ */
    const int64 t0 = cv::getTickCount();
    input_ = ConvertToMat(imgVal);                    // zero-copy
    convertMs_ = (cv::getTickCount()-t0)/cv::getTickFrequency()*1e3;

    channel_ = (imgVal.IsObject() && !imgVal.IsBuffer())
        ? ExtractChannelOrder(imgVal.As<Napi::Object>()
                               .Get("channels").As<Napi::String>())
        : (input_.channels()==4 ? "BGRA"
           : input_.channels()==3 ? "BGR" : "GRAY");
  }

protected:
  void Execute() override {
    /* ─ medir taskMs (recorte) ─ */
    const int64 t0 = cv::getTickCount();

    const int W=input_.cols, H=input_.rows;
    int x1 = normalized_? int(std::round(x1_*W)) : int(std::lround(x1_));
    int y1 = normalized_? int(std::round(y1_*H)) : int(std::lround(y1_));
    int x2 = normalized_? int(std::round(x2_*W)) : int(std::lround(x2_));
    int y2 = normalized_? int(std::round(y2_*H)) : int(std::lround(y2_));

    x1 = std::clamp(x1,0,W-1); x2 = std::clamp(x2,0,W-1);
    y1 = std::clamp(y1,0,H-1); y2 = std::clamp(y2,0,H-1);
    if(x2<x1) std::swap(x1,x2);
    if(y2<y1) std::swap(y1,y2);

    result_ = input_(cv::Rect(x1,y1,x2-x1+1,y2-y1+1));     // alias

    taskMs_ = (cv::getTickCount()-t0)/cv::getTickFrequency()*1e3;

    /* ─ JPEG opcional (encodeMs) ─ */
    if(encJpg_){
      const cv::Mat& srcJpg = (channel_=="BGR")? result_
                         : ToBgrForJpg(result_,channel_);
      encodeMs_ = EncodeToJpgFast(srcJpg, jpgBuf_);         // utils.h
    }
  }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::Value jsImg = encJpg_
        ? VectorToBuffer(env,std::move(jpgBuf_))            // 0-copy
        : MatToRawJS(env,result_.clone(),channel_);         // contiguo

    Napi::Object out = Napi::Object::New(env);
    out.Set("image",  jsImg);
    out.Set("timing", MakeTimingJS(env,convertMs_,taskMs_,encodeMs_));
    Callback().Call({ env.Null(), out });
  }

  void OnError(const Napi::Error& e) override {
    Callback().Call({ e.Value(), Env().Null() });
  }

private:
  cv::Mat input_, result_;
  double x1_, y1_, x2_, y2_;
  bool   normalized_, encJpg_;
  std::string channel_;

  double convertMs_{0.0}, taskMs_{0.0}, encodeMs_{0.0};
  std::vector<uchar> jpgBuf_;
};

/*──────── binding: crop(image,x1,y1,x2,y2,normalized,[encodeJpg],cb) ─*/
Napi::Value Crop(const Napi::CallbackInfo& info)
{
  Napi::Env env = info.Env();
  if(info.Length()<7||info.Length()>8||!info[info.Length()-1].IsFunction())
    return Napi::TypeError::New(env,
      "crop(image,x1,y1,x2,y2,normalized,[encodeJpg],callback)").Value();

  int i=0;
  Napi::Value img = info[i++];
  double x1 = info[i++].As<Napi::Number>(),
         y1 = info[i++].As<Napi::Number>(),
         x2 = info[i++].As<Napi::Number>(),
         y2 = info[i++].As<Napi::Number>();
  bool norm = info[i++].As<Napi::Boolean>();
  bool jpg  = (info.Length()-i==2)? info[i++].As<Napi::Boolean>() : false;
  Napi::Function cb = info[i].As<Napi::Function>();

  (new CropWorker(cb,img,x1,y1,x2,y2,norm,jpg))->Queue();
  return env.Undefined();
}
