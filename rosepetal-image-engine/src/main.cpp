#include <napi.h>

Napi::Value Resize(const Napi::CallbackInfo& info);
Napi::Value Rotate(const Napi::CallbackInfo& info);
Napi::Value Crop(const Napi::CallbackInfo& info); 
Napi::Value Concat(const Napi::CallbackInfo& info);

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set(Napi::String::New(env, "resize"), Napi::Function::New(env, Resize));
  exports.Set(Napi::String::New(env, "rotate"), Napi::Function::New(env, Rotate));
  exports.Set(Napi::String::New(env, "crop"), Napi::Function::New(env, Crop));
  exports.Set(Napi::String::New(env, "concat"), Napi::Function::New(env, Concat));
  return exports;
}

NODE_API_MODULE(addon, Init)