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
             double x,double y,double width,double height,
             bool normalized,std::string outputFormat,int quality = 90)
    : Napi::AsyncWorker(cb),
      x_(x),y_(y),width_(width),height_(height),
      normalized_(normalized),outputFormat_(std::move(outputFormat)),quality_(quality)
  {
    /* ─ medir convertMs ─ */
    const int64 t0 = cv::getTickCount();
    input_ = ConvertToMat(imgVal);                    // zero-copy
    convertMs_ = (cv::getTickCount()-t0)/cv::getTickFrequency()*1e3;

    if (imgVal.IsObject() && !imgVal.IsBuffer()) {
      Napi::Object obj = imgVal.As<Napi::Object>();
      
      // Check for colorSpace field
      if (obj.Has("colorSpace")) {
        channel_ = obj.Get("colorSpace").As<Napi::String>().Utf8Value();
      }
      // Default based on channel count
      else {
        channel_ = (input_.channels() == 4) ? "BGRA"
                 : (input_.channels() == 3) ? "BGR" 
                 : "GRAY";
      }
    } else {
      // Buffer input - determine from OpenCV Mat
      channel_ = (input_.channels() == 4) ? "BGRA"
               : (input_.channels() == 3) ? "BGR"
               : "GRAY";
    }
  }

protected:
  void Execute() override {
    /* ─ medir taskMs (recorte) ─ */
    const int64 t0 = cv::getTickCount();

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
      const cv::Mat& srcForEncoding = (channel_=="BGR")? result_
                         : ToBgrForJpg(result_,channel_);
      encodeMs_ = EncodeToFormat(srcForEncoding, encodedBuf_, outputFormat_, quality_);
    }
  }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::Value jsImg = (outputFormat_ != "raw")
        ? VectorToBuffer(env,std::move(encodedBuf_))        // 0-copy
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
  double x_, y_, width_, height_;
  bool   normalized_;
  std::string outputFormat_;
  int quality_;
  std::string channel_;

  double convertMs_{0.0}, taskMs_{0.0}, encodeMs_{0.0};
  std::vector<uchar> encodedBuf_;
};

/*──────── binding: crop(image,x,y,width,height,normalized,[outputFormat],[quality],cb) ─*/
Napi::Value Crop(const Napi::CallbackInfo& info)
{
  Napi::Env env = info.Env();
  if(info.Length()<7||info.Length()>9||!info[info.Length()-1].IsFunction())
    return Napi::TypeError::New(env,
      "crop(image,x,y,width,height,normalized,[outputFormat],[quality],callback)").Value();

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
  
  if (info.Length() >= 8) {
    outputFormat = info[i++].As<Napi::String>().Utf8Value();
  }
  
  if (info.Length() == 9) {
    quality = info[i++].As<Napi::Number>().Int32Value();
  }
  
  Napi::Function cb = info[i].As<Napi::Function>();

  (new CropWorker(cb,img,x,y,width,height,norm,outputFormat,quality))->Queue();
  return env.Undefined();
}
