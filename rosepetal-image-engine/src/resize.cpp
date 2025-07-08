#include <napi.h>
#include <opencv2/opencv.hpp>
#include <chrono>

class ResizeWorker : public Napi::AsyncWorker {
public:
  ResizeWorker(Napi::Function& callback, Napi::Object& imageObject, int targetWidth, int targetHeight)
    : Napi::AsyncWorker(callback),
      targetWidth(targetWidth),
      targetHeight(targetHeight) {
    
    this->width = imageObject.Get("width").As<Napi::Number>().Int32Value();
    this->height = imageObject.Get("height").As<Napi::Number>().Int32Value();
    this->channelsStr = imageObject.Get("channels").As<Napi::String>().Utf8Value();
    Napi::Buffer<uint8_t> dataBuffer = imageObject.Get("data").As<Napi::Buffer<uint8_t>>();
    
    int cvType = this->getOpenCVType(this->channelsStr);
    this->inputMat = cv::Mat(this->height, this->width, cvType, dataBuffer.Data()).clone();
  }

protected:
  void Execute() override {
    try {
        auto t_start = std::chrono::high_resolution_clock::now();
        
        cv::Mat resizedMat;
        cv::resize(this->inputMat, resizedMat, cv::Size(this->targetWidth, this->targetHeight));
        this->resultMat = resizedMat;

        auto t_end = std::chrono::high_resolution_clock::now();
        this->processingTime = std::chrono::duration<double, std::milli>(t_end - t_start).count();

    } catch (const cv::Exception& e) {
        Napi::AsyncWorker::SetError(e.what());
    }
  }

  void OnOK() override {
    Napi::Env env = Env();
    
    Napi::Object outputImageObject = Napi::Object::New(env);
    outputImageObject.Set("width", Napi::Number::New(env, this->resultMat.cols));
    outputImageObject.Set("height", Napi::Number::New(env, this->resultMat.rows));
    outputImageObject.Set("channels", Napi::String::New(env, this->channelsStr));

    size_t bufferSize = this->resultMat.total() * this->resultMat.elemSize();
    outputImageObject.Set("data", Napi::Buffer<uint8_t>::Copy(env, this->resultMat.data, bufferSize));

    Callback().Call({Env().Null(), outputImageObject});
  }

  void OnError(const Napi::Error& e) override {
      Callback().Call({e.Value(), Env().Null()});
  }

private:
  int getOpenCVType(const std::string& channelsStr) {
      if (channelsStr.find("RGBA") != std::string::npos || channelsStr.find("BGRA") != std::string::npos) return CV_8UC4;
      if (channelsStr.find("RGB") != std::string::npos || channelsStr.find("BGR") != std::string::npos) return CV_8UC3;
      if (channelsStr.find("GRAY") != std::string::npos) return CV_8UC1;
      return CV_8UC3; 
  }

  cv::Mat inputMat;
  cv::Mat resultMat;
  int width, height;
  std::string channelsStr;
  int targetWidth, targetHeight;
  double processingTime;
};

Napi::Value Resize(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  
  if (info.Length() != 4 || !info[0].IsObject() || !info[1].IsNumber() || !info[2].IsNumber() || !info[3].IsFunction()) {
    Napi::TypeError::New(env, "Expected (imageObject, width, height, callback)").ThrowAsJavaScriptException();
    return env.Null();
  }

  Napi::Object imageObject = info[0].As<Napi::Object>();
  int targetWidth = info[1].As<Napi::Number>().Int32Value();
  int targetHeight = info[2].As<Napi::Number>().Int32Value();
  Napi::Function callback = info[3].As<Napi::Function>();

  ResizeWorker* worker = new ResizeWorker(callback, imageObject, targetWidth, targetHeight);
  worker->Queue();
  
  return env.Undefined();
}