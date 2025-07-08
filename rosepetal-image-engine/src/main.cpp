#include <napi.h>

Napi::Value Resize(const Napi::CallbackInfo& info);

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set(Napi::String::New(env, "resize"), Napi::Function::New(env, Resize));
  return exports;
}

NODE_API_MODULE(addon, Init)