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
                bool encodeJpg)
    : Napi::AsyncWorker(cb),
      t_(top),b_(bottom),l_(left),r_(right),
      padColorRGB(padRGB),
      encJpg(encodeJpg)
  {
    /* convertMs — zero‑copy → cv::Mat */
    const int64 t0=cv::getTickCount();
    src_=ConvertToMat(imgVal);
    convertMs_=(cv::getTickCount()-t0)/cv::getTickFrequency()*1e3;

    channel_= (imgVal.IsObject()&&!imgVal.IsBuffer())
        ? ExtractChannelOrder(imgVal.As<Napi::Object>()
                               .Get("channels").As<Napi::String>())
        : (src_.channels()==4?"BGRA":src_.channels()==3?"BGR":"GRAY");

    padClrImg=padColorRGB;
    if(channel_=="RGB"||channel_=="RGBA") std::swap(padClrImg[0],padClrImg[2]);
  }

protected:
  void Execute() override {
    const int64 t0=cv::getTickCount();
    cv::copyMakeBorder(src_,dst_,t_,b_,l_,r_,cv::BORDER_CONSTANT,padClrImg);
    taskMs_=(cv::getTickCount()-t0)/cv::getTickFrequency()*1e3;

    if(encJpg){
      const cv::Mat& jpgIn=(channel_=="BGR")?dst_:ToBgrForJpg(dst_,channel_);
      encodeMs_=EncodeToJpgFast(jpgIn,jpgBuf_,90);
    }
  }

  void OnOK() override {
    Napi::Env env=Env();
    Napi::Value jsImg=encJpg?VectorToBuffer(env,std::move(jpgBuf_))
                            :MatToRawJS(env,dst_,channel_);

    Napi::Object res=Napi::Object::New(env);
    res.Set("image",jsImg);
    res.Set("timing",MakeTimingJS(env,convertMs_,taskMs_,encodeMs_));
    Callback().Call({env.Null(),res});
  }

private:
  cv::Mat src_,dst_;
  int t_,b_,l_,r_;
  cv::Scalar padColorRGB,padClrImg;
  std::string channel_;
  bool encJpg;

  double convertMs_{0},taskMs_{0},encodeMs_{0};
  std::vector<uchar> jpgBuf_;
};

/*──────── binding: padding(img,top,bottom,left,right,padHex,[jpg],cb) ─*/
Napi::Value Padding(const Napi::CallbackInfo& info){
  Napi::Env env=info.Env();
  if(info.Length()<7||info.Length()>8||!info[info.Length()-1].IsFunction())
    return Napi::TypeError::New(env,
      "padding(image,top,bottom,left,right,padHex,[encodeJpg],callback)").Value();

  int i=0;
  Napi::Value img=info[i++];
  int top   =info[i++].As<Napi::Number>();
  int bottom=info[i++].As<Napi::Number>();
  int left  =info[i++].As<Napi::Number>();
  int right =info[i++].As<Napi::Number>();
  cv::Scalar pad=ParseColor(info[i++].As<Napi::String>());

  bool jpg=false;
  if(info.Length()-i==2) jpg=info[i++].As<Napi::Boolean>();
  Napi::Function cb=info[i].As<Napi::Function>();

  (new PaddingWorker(cb,img,top,bottom,left,right,pad,jpg))->Queue();
  return env.Undefined();
}
