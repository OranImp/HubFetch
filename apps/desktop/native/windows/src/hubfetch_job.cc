// apps/desktop/native/windows/src/hubfetch_job.cc
//
// Todo 25 scaffold: the minimal Electron-ABI x64 Node-API addon that proves the
// build / loader / packaging contract end to end.
//
//   - getRuntimeInfo(): version/export probe. Returns the compile-time ABI
//     (NODE_MODULE_VERSION), arch, and N-API version so the main-process loader
//     can validate ABI/architecture/export shape before anything is enabled.
//   - createKillOnCloseJob(): typed NOT-IMPLEMENTED stub. The full Windows Job
//     Object bridge (CreateJobObjectW + JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE +
//     AssignProcessToJobObject + wait-for-empty) lands in Todo 26. Clone support
//     MUST remain disabled until that bridge reports ready (Todo 27 gates the
//     clone start behind a ready bridge).
//
// Build: node-gyp rebuild --target=<electron> --arch=x64
//   --dist-url=https://electronjs.org/headers (see ../../scripts/native-build.mjs).
// Must NOT be compiled at app startup or packaged as source/PDB/object/toolchain.

#include <node_version.h>
#include <napi.h>

namespace {

constexpr const char* kAddonName = "hubfetch_job";
constexpr const char* kAddonVersion = "0.1.0";

#if defined(_M_X64) || defined(__x86_64__)
constexpr const char* kArch = "x64";
#else
constexpr const char* kArch = "unknown";
#endif

// Version/export probe. The loader compares nodeAbi against
// process.versions.modules of the running Electron main process.
Napi::Value GetRuntimeInfo(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object result = Napi::Object::New(env);
  result.Set("addonName", Napi::String::New(env, kAddonName));
  result.Set("addonVersion", Napi::String::New(env, kAddonVersion));
  result.Set("nodeAbi", Napi::Number::New(env, static_cast<double>(NODE_MODULE_VERSION)));
  result.Set("arch", Napi::String::New(env, kArch));
  result.Set(
    "napiVersion",
    Napi::Number::New(env, static_cast<double>(Napi::VersionManagement::GetNapiVersion(env))));
  return result;
}

// Todo 26 implements the real Job Object bridge. Until then the export exists so
// the loader validates the full export shape, and callers receive a typed
// not-implemented result instead of a crash or a silent clone.
Napi::Value CreateKillOnCloseJob(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object result = Napi::Object::New(env);
  result.Set("status", Napi::String::New(env, "not-implemented"));
  result.Set("code", Napi::String::New(env, "HUBFETCH_JOB_NOT_IMPLEMENTED"));
  result.Set(
    "message",
    Napi::String::New(
      env,
      "Windows Job Object bridge lands in Todo 26; this stub proves the loader/packaging contract only."));
  return result;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("addonName", Napi::String::New(env, kAddonName));
  exports.Set("getRuntimeInfo", Napi::Function::New(env, GetRuntimeInfo));
  exports.Set("createKillOnCloseJob", Napi::Function::New(env, CreateKillOnCloseJob));
  return exports;
}

}  // namespace

NODE_API_MODULE(hubfetch_job, Init)