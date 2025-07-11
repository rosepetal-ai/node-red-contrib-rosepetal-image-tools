// ───────── src/rotate.cpp ──────────────────────────────────────────────
#include <napi.h>
#include <opencv2/opencv.hpp>
#include <chrono>
#include <cmath>
#include "utils.h"          // ParseColor, VectorToBuffer, MatToRawJS…

// ──────────────────────────────── Worker
class RotateWorker : public Napi::AsyncWorker {
public:
  RotateWorker(Napi::Function& cb,
               const Napi::Value& imgVal,
               double angDeg,
               cv::Scalar padRGB,   // R,G,B
               bool   encJpg)
    : Napi::AsyncWorker(cb),
      angleDeg(angDeg),
      padColorRGB(padRGB),
      encodeJpg(encJpg)
  {
    try {
      inputMat = ConvertToMat(imgVal);            // zero-copy RAW
      channelOrder = (imgVal.IsObject() && !imgVal.IsBuffer())
        ? ExtractChannelOrder(
            imgVal.As<Napi::Object>().Get("channels")
                  .As<Napi::String>().Utf8Value())
        : (inputMat.channels()==4 ? "BGRA" :
           inputMat.channels()==3 ? "BGR"  : "GRAY");
    } catch (const Napi::Error& e) { SetError(e.Message()); }
  }

protected:
  void Execute() override {
    try {
      auto t0 = std::chrono::steady_clock::now();          

      // Ajustar color al orden real de la imagen
      padClrImg = padColorRGB;                             // RGB
      if (channelOrder == "RGB" || channelOrder == "RGBA")
        std::swap(padClrImg[0], padClrImg[2]);             // → BGR/BGRA

      // Fast-path 0/90/180/270°
      double n = std::fmod(angleDeg + 360.0, 360.0), eps = 1e-3;
      auto near=[&](double a){ return std::abs(n-a)<eps; };

      if (near(0) || near(90) || near(180) || near(270)) {
        if      (near(0))   resultMat = inputMat; // alias
        else if (near(90))  cv::rotate(inputMat,resultMat,cv::ROTATE_90_CLOCKWISE);
        else if (near(180)) cv::rotate(inputMat,resultMat,cv::ROTATE_180);
        else                cv::rotate(inputMat,resultMat,cv::ROTATE_90_COUNTERCLOCKWISE);
      } else {
        // Ángulos arbitrarios (sempre PAD)
        int w=inputMat.cols, h=inputMat.rows;
        cv::Point2f c(w/2.f,h/2.f);
        cv::Mat M = cv::getRotationMatrix2D(c, angleDeg, 1.0);

        double cosA=std::abs(M.at<double>(0,0));
        double sinA=std::abs(M.at<double>(0,1));
        cv::Size dst(int(h*sinA+w*cosA), int(h*cosA+w*sinA));

        M.at<double>(0,2) += dst.width /2.0 - c.x;
        M.at<double>(1,2) += dst.height/2.0 - c.y;

        cv::warpAffine(inputMat,resultMat,M,dst,
                       cv::INTER_LINEAR,cv::BORDER_CONSTANT,padClrImg);
      }

      taskMs = std::chrono::duration<double,std::milli>(
                 std::chrono::steady_clock::now() - t0).count(); 

      // JPEG opcional
      if (encodeJpg) {
        cv::Mat tmp = ToBgrForJpg(resultMat, channelOrder);
        encodeMs = EncodeToJpgFast(tmp, jpgBuf);
      }
    } catch (const std::exception& e) { SetError(e.what()); }
  }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::Value jsImg = encodeJpg
        ? VectorToBuffer(env, std::move(jpgBuf))
        : MatToRawJS(env, resultMat, channelOrder);

    Napi::Object res = Napi::Object::New(env);
    res.Set("image",  jsImg);
    res.Set("timing", MakeTimingJS(env, 0.0, taskMs, encodeMs)); // convertMs=0
    Callback().Call({ env.Null(), res });
  }

  void OnError(const Napi::Error& e) override {
    Callback().Call({ e.Value(), Env().Null() });
  }

private:
  cv::Mat inputMat, resultMat;
  double  angleDeg;
  cv::Scalar padColorRGB, padClrImg;
  bool    encodeJpg;

  std::string channelOrder;
  double taskMs  = 0.0;
  double encodeMs = 0.0;
  std::vector<uchar> jpgBuf;
};

// ───────── Binding JS → C++ ────────────────────────────────────────────
// rotate(image, angleDeg, [padColor], [encodeJpg], callback)
Napi::Value Rotate(const Napi::CallbackInfo& info)
{
  Napi::Env env = info.Env();
  if (info.Length() < 4 || info.Length() > 6 ||
      !info[info.Length()-1].IsFunction())
    return Napi::TypeError::New(env,
      "rotate(image, angleDeg, [padColor], [encodeJpg], callback)").Value();

  int i = 0;
  Napi::Value img   = info[i++];
  double angleDeg   = info[i++].As<Napi::Number>().DoubleValue();

  std::string padColorStr = "#000000";      // negro por defecto
  if (info[i].IsString()) padColorStr = info[i++].As<Napi::String>();

  bool encJpg = false;
  if (info.Length()-i == 2) encJpg = info[i++].As<Napi::Boolean>();

  Napi::Function cb = info[i].As<Napi::Function>();

  auto* worker = new RotateWorker(
      cb,
      img,
      angleDeg,
      ParseColor(padColorStr),   // RGB
      encJpg);
  worker->Queue();
  return env.Undefined();
}
