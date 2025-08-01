#include <napi.h>

Napi::Value Resize(const Napi::CallbackInfo& info);
Napi::Value Rotate(const Napi::CallbackInfo& info);
Napi::Value Crop(const Napi::CallbackInfo& info); 
Napi::Value Concat(const Napi::CallbackInfo& info);
Napi::Value Padding(const Napi::CallbackInfo& info);
Napi::Value Filter(const Napi::CallbackInfo& info);
Napi::Value Mosaic(const Napi::CallbackInfo& info);
Napi::Value Blend(const Napi::CallbackInfo& info);

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set(Napi::String::New(env, "resize"), Napi::Function::New(env, Resize));
  exports.Set(Napi::String::New(env, "rotate"), Napi::Function::New(env, Rotate));
  exports.Set(Napi::String::New(env, "crop"), Napi::Function::New(env, Crop));
  exports.Set(Napi::String::New(env, "concat"), Napi::Function::New(env, Concat));
  exports.Set(Napi::String::New(env, "padding"), Napi::Function::New(env, Padding));
  exports.Set(Napi::String::New(env, "filter"), Napi::Function::New(env, Filter));
  exports.Set(Napi::String::New(env, "mosaic"), Napi::Function::New(env, Mosaic));
  exports.Set(Napi::String::New(env, "blend"), Napi::Function::New(env, Blend));
  return exports;
}

NODE_API_MODULE(addon, Init)