// ───────── src/concat.cpp (ultra‑optimised + pad colour) ─────────
#include <napi.h>
#include <opencv2/opencv.hpp>
#include "utils.h"

/*------------------------------------------------------------------------*/
class ConcatWorker final : public Napi::AsyncWorker {
public:
  ConcatWorker(Napi::Function cb,
               const std::vector<Napi::Value>& jsImgs,
               std::string                       dir,
               std::string                       strat,
               cv::Scalar                        padRGB,
               bool                              jpg)
    : Napi::AsyncWorker(cb),
      direction(std::move(dir)),
      strategy (std::move(strat)),
      padColorRGB(padRGB),
      encodeJpg(jpg)
  {
    const int64 t0=cv::getTickCount();
    mats.reserve(jsImgs.size());
    for(const auto& v:jsImgs) mats.emplace_back(ConvertToMat(v).clone());
    convertMs=(cv::getTickCount()-t0)/cv::getTickFrequency()*1e3;

    channel = (jsImgs.size() && jsImgs[0].IsObject() && !jsImgs[0].IsBuffer())
        ? ExtractChannelOrder(jsImgs[0].As<Napi::Object>()
                               .Get("channels").As<Napi::String>())
        : (mats[0].channels()==4?"BGRA":mats[0].channels()==3?"BGR":"GRAY");

    padClrImg = padColorRGB;
    if(channel=="RGB"||channel=="RGBA") std::swap(padClrImg[0],padClrImg[2]);
  }

protected:
  void Execute() override {
    const int64 t0=cv::getTickCount();

    int maxW=0,maxH=0;
    for(const auto& m:mats){ maxW=std::max(maxW,m.cols); maxH=std::max(maxH,m.rows); }

    std::vector<cv::Mat> tiles; tiles.reserve(mats.size());
    for(auto& m:mats){
      if(direction=="right"||direction=="left"){
        preprocessTile(m,maxH,strategy.find("resize")!=std::string::npos,
                       strategy=="pad-start",strategy=="pad-end");
      }else{
        preprocessTile(m,maxW,strategy.find("resize")!=std::string::npos,
                       strategy=="pad-start",strategy=="pad-end",true);
      }
      tiles.push_back(std::move(m));
    }

    if(direction=="right"||direction=="left"){
      cv::hconcat(tiles,result);
      if(direction=="left") cv::flip(result,result,1);
    }else{
      if(direction=="up")std::reverse(tiles.begin(), tiles.end());  // invertir orden
        cv::vconcat(tiles,result);  
    }

    taskMs=(cv::getTickCount()-t0)/cv::getTickFrequency()*1e3;

    if(encodeJpg){
      cv::Mat tmp=ToBgrForJpg(result,channel);
      encodeMs=EncodeToJpgFast(tmp,jpgBuf);
    }
  }

  void OnOK() override {
    Napi::Env env=Env();
    Napi::Value jsImg = encodeJpg ? VectorToBuffer(env,std::move(jpgBuf))
                                  : MatToRawJS(env,result,channel);

    Napi::Object out=Napi::Object::New(env);
    out.Set("image",jsImg);
    out.Set("timing",MakeTimingJS(env,convertMs,taskMs,encodeMs));
    Callback().Call({env.Null(),out});
  }

private:
  void preprocessTile(cv::Mat& m,int base,bool doResize,
                             bool padStart,bool padEnd,bool vertical=false)
  {
    if(doResize){
      double scale = vertical? double(base)/m.cols : double(base)/m.rows;
      cv::resize(m,m, vertical? cv::Size(base,int(m.rows*scale))
                              : cv::Size(int(m.cols*scale),base));
      return;
    }
    int delta = vertical? base - m.cols : base - m.rows;
    if(delta<=0) return;

    int before = padStart? delta : 0;
    int after  = padEnd  ? delta : (padStart?0:delta/2);
    if(strategy=="pad-both"){ before=delta/2; after=delta-before; }

    if(vertical)
      cv::copyMakeBorder(m,m,0,0,before,after,cv::BORDER_CONSTANT,padClrImg);
    else
      cv::copyMakeBorder(m,m,before,after,0,0,cv::BORDER_CONSTANT,padClrImg);
  }

  std::vector<cv::Mat> mats;
  cv::Mat result;
  std::string direction,strategy,channel;
  cv::Scalar padColorRGB,padClrImg;
  bool encodeJpg;
  double convertMs=0,taskMs=0,encodeMs=0;
  std::vector<uchar> jpgBuf;
};

/*------------------------------------------------------------------------*/
Napi::Value Concat(const Napi::CallbackInfo& info){
  Napi::Env env=info.Env();
  if(info.Length()<5||!info[0].IsArray()||!info[1].IsString()||
     !info[2].IsString()||!info[3].IsString()||!info[info.Length()-1].IsFunction()){
    Napi::TypeError::New(env,
      "concat(array, direction, strategy, padHex, [jpg], cb)").ThrowAsJavaScriptException();
    return env.Null();
  }

  auto arr=info[0].As<Napi::Array>();
  std::vector<Napi::Value> raw; raw.reserve(arr.Length());
  for(uint32_t i=0;i<arr.Length();++i) raw.push_back(arr.Get(i));

  std::string dir = info[1].As<Napi::String>();
  std::string st  = info[2].As<Napi::String>();
  cv::Scalar  pad = ParseColor(info[3].As<Napi::String>());

  bool jpg = (info.Length()==6)? info[4].As<Napi::Boolean>().Value():false;
  size_t cbIdx = (info.Length()==6)? 5:4;

  (new ConcatWorker(info[cbIdx].As<Napi::Function>(),raw,dir,st,pad,jpg))->Queue();
  return env.Undefined();
}
