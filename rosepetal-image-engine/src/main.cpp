#include <napi.h>

Napi::Value Resize(const Napi::CallbackInfo& info);
Napi::Value Rotate(const Napi::CallbackInfo& info);
Napi::Value Crop(const Napi::CallbackInfo& info);
Napi::Value Concat(const Napi::CallbackInfo& info);
Napi::Value Padding(const Napi::CallbackInfo& info);
Napi::Value Filter(const Napi::CallbackInfo& info);
Napi::Value Mosaic(const Napi::CallbackInfo& info);
Napi::Value AdvancedMosaic(const Napi::CallbackInfo& info);
Napi::Value Blend(const Napi::CallbackInfo& info);
Napi::Value AddMask(const Napi::CallbackInfo& info);
Napi::Value AddMasks(const Napi::CallbackInfo& info);
Napi::Value AddBBs(const Napi::CallbackInfo& info);
Napi::Value ImageAlign(const Napi::CallbackInfo& info);
Napi::Value Draw(const Napi::CallbackInfo& info);

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set(Napi::String::New(env, "resize"), Napi::Function::New(env, Resize));
  exports.Set(Napi::String::New(env, "rotate"), Napi::Function::New(env, Rotate));
  exports.Set(Napi::String::New(env, "crop"), Napi::Function::New(env, Crop));
  exports.Set(Napi::String::New(env, "concat"), Napi::Function::New(env, Concat));
  exports.Set(Napi::String::New(env, "padding"), Napi::Function::New(env, Padding));
  exports.Set(Napi::String::New(env, "filter"), Napi::Function::New(env, Filter));
  exports.Set(Napi::String::New(env, "mosaic"), Napi::Function::New(env, Mosaic));
  exports.Set(Napi::String::New(env, "advancedMosaic"), Napi::Function::New(env, AdvancedMosaic));
  exports.Set(Napi::String::New(env, "blend"), Napi::Function::New(env, Blend));
  exports.Set(Napi::String::New(env, "addMask"), Napi::Function::New(env, AddMask));
  exports.Set(Napi::String::New(env, "addMasks"), Napi::Function::New(env, AddMasks));
  exports.Set(Napi::String::New(env, "addBBs"), Napi::Function::New(env, AddBBs));
  exports.Set(Napi::String::New(env, "imageAlign"), Napi::Function::New(env, ImageAlign));
  exports.Set(Napi::String::New(env, "draw"), Napi::Function::New(env, Draw));
  return exports;
}

NODE_API_MODULE(addon, Init)
