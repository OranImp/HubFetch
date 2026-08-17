// apps/desktop/native/windows/src/hubfetch_job.cc
//
// Todo 26: the Windows Job Object containment addon. The full bridge
// (CreateJobObjectW + JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE + completion-port
// wait-for-empty) lives in job_handle.{h,cc}; this file wires the exports:
//
//   - getRuntimeInfo(): ABI/arch/version probe for the main-process loader.
//   - getNativeLayout(): x64 structure/layout constants (static_assert locked).
//   - getProcessHandleCount(): handle-count probe for the growth tests.
//   - createKillOnCloseJob(): returns a JobHandle instance (typed errors throw).
//
// Build: node-gyp rebuild --target=<electron> --arch=x64
//   --dist-url=https://electronjs.org/headers (see ../../scripts/native-build.mjs).
// Must NOT be compiled at app startup or packaged as source/PDB/object/toolchain.

#include <node_version.h>
#include <windows.h>

#include <napi.h>

#include "askpass_session.h"
#include "job_handle.h"

namespace {

constexpr const char* kAddonName = "hubfetch_job";
constexpr const char* kAddonVersion = "0.2.0";

#if defined(_M_X64) || defined(__x86_64__)
constexpr const char* kArch = "x64";
#else
constexpr const char* kArch = "unknown";
#endif

// ---------------------------------------------------------------------------
// x64 structure/layout invariants. These are compile-time proof that the
// Windows structs the bridge relies on have the exact x64 layout the tests
// assert at runtime via getNativeLayout(). Any platform/toolset drift fails
// the build instead of silently producing a wrong bridge.
// ---------------------------------------------------------------------------
static_assert(sizeof(void*) == 8, "hubfetch_job requires x64 (8-byte pointers)");
static_assert(sizeof(JOBOBJECT_BASIC_LIMIT_INFORMATION) == 64,
              "x64 JOBOBJECT_BASIC_LIMIT_INFORMATION layout drift");
static_assert(offsetof(JOBOBJECT_BASIC_LIMIT_INFORMATION, LimitFlags) == 16,
              "x64 LimitFlags offset drift");
static_assert(sizeof(IO_COUNTERS) == 48, "x64 IO_COUNTERS layout drift");
static_assert(sizeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION) == 144,
              "x64 JOBOBJECT_EXTENDED_LIMIT_INFORMATION layout drift");
static_assert(offsetof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION, BasicLimitInformation.LimitFlags) ==
                16,
              "x64 extended-limit LimitFlags offset drift");
static_assert(sizeof(JOBOBJECT_BASIC_PROCESS_ID_LIST) == 16,
              "x64 JOBOBJECT_BASIC_PROCESS_ID_LIST layout drift");
static_assert(offsetof(JOBOBJECT_BASIC_PROCESS_ID_LIST, NumberOfAssignedProcesses) == 0,
              "x64 NumberOfAssignedProcesses offset drift");
static_assert(offsetof(JOBOBJECT_BASIC_PROCESS_ID_LIST, NumberOfProcessIdsInList) == 4,
              "x64 NumberOfProcessIdsInList offset drift");
static_assert(offsetof(JOBOBJECT_BASIC_PROCESS_ID_LIST, ProcessIdList) == 8,
              "x64 ProcessIdList offset drift");
static_assert(sizeof(JOBOBJECT_ASSOCIATE_COMPLETION_PORT) == 16,
              "x64 JOBOBJECT_ASSOCIATE_COMPLETION_PORT layout drift");
static_assert(offsetof(JOBOBJECT_ASSOCIATE_COMPLETION_PORT, CompletionKey) == 0,
              "x64 CompletionKey offset drift");
static_assert(offsetof(JOBOBJECT_ASSOCIATE_COMPLETION_PORT, CompletionPort) == 8,
              "x64 CompletionPort offset drift");
static_assert(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE == 0x00002000,
              "JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE value drift");
static_assert(JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO == 4,
              "JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO value drift");

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

// x64 structure/layout + flag/message constants, exported for the native tests.
Napi::Value GetNativeLayout(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object o = Napi::Object::New(env);
  o.Set("pointerSize", Napi::Number::New(env, static_cast<double>(sizeof(void*))));
  o.Set("sizeofBasicLimitInformation",
        Napi::Number::New(env, static_cast<double>(sizeof(JOBOBJECT_BASIC_LIMIT_INFORMATION))));
  o.Set("offsetofLimitFlags",
        Napi::Number::New(env, static_cast<double>(
                                 offsetof(JOBOBJECT_BASIC_LIMIT_INFORMATION, LimitFlags))));
  o.Set("sizeofIoCounters", Napi::Number::New(env, static_cast<double>(sizeof(IO_COUNTERS))));
  o.Set("sizeofExtendedLimitInformation",
        Napi::Number::New(env, static_cast<double>(sizeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))));
  o.Set("offsetofExtendedLimitFlags",
        Napi::Number::New(
          env, static_cast<double>(offsetof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                                            BasicLimitInformation.LimitFlags))));
  o.Set("sizeofBasicProcessIdList",
        Napi::Number::New(env, static_cast<double>(sizeof(JOBOBJECT_BASIC_PROCESS_ID_LIST))));
  o.Set("offsetofNumberOfAssignedProcesses",
        Napi::Number::New(
          env, static_cast<double>(offsetof(JOBOBJECT_BASIC_PROCESS_ID_LIST,
                                            NumberOfAssignedProcesses))));
  o.Set("offsetofNumberOfProcessIdsInList",
        Napi::Number::New(
          env, static_cast<double>(offsetof(JOBOBJECT_BASIC_PROCESS_ID_LIST,
                                            NumberOfProcessIdsInList))));
  o.Set("offsetofProcessIdList",
        Napi::Number::New(
          env, static_cast<double>(offsetof(JOBOBJECT_BASIC_PROCESS_ID_LIST, ProcessIdList))));
  o.Set("sizeofAssociateCompletionPort",
        Napi::Number::New(env, static_cast<double>(sizeof(JOBOBJECT_ASSOCIATE_COMPLETION_PORT))));
  o.Set("offsetofCompletionKey",
        Napi::Number::New(
          env, static_cast<double>(offsetof(JOBOBJECT_ASSOCIATE_COMPLETION_PORT, CompletionKey))));
  o.Set("offsetofCompletionPort",
        Napi::Number::New(
          env, static_cast<double>(offsetof(JOBOBJECT_ASSOCIATE_COMPLETION_PORT,
                                            CompletionPort))));
  o.Set("killOnCloseFlag",
        Napi::Number::New(env, static_cast<double>(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)));
  o.Set("activeProcessZeroMessage",
        Napi::Number::New(env, static_cast<double>(JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO)));
  return o;
}

// Current-process handle count used by the 100-cycle handle-growth tests.
Napi::Value GetProcessHandleCount(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  DWORD count = 0;
  // :: qualification disambiguates from this file's N-API export of the same name.
  if (!::GetProcessHandleCount(GetCurrentProcess(), &count)) count = 0;
  return Napi::Number::New(env, static_cast<double>(count));
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("addonName", Napi::String::New(env, kAddonName));
  exports.Set("getRuntimeInfo", Napi::Function::New(env, GetRuntimeInfo));
  exports.Set("getNativeLayout", Napi::Function::New(env, GetNativeLayout));
  exports.Set("getProcessHandleCount", Napi::Function::New(env, GetProcessHandleCount));
  exports.Set("createKillOnCloseJob",
              Napi::Function::New(env, hubfetch_job::JobHandle::CreateKillOnCloseJob));
  hubfetch_job::JobHandle::Init(env, exports);
  // Todo 30: Job-bound one-shot AskPass session + DACL diagnostic export.
  hubfetch_job::AskPassSession::Init(env, exports);
  return exports;
}

}  // namespace

NODE_API_MODULE(hubfetch_job, Init)