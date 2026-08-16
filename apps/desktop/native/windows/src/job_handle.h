// apps/desktop/native/windows/src/job_handle.h
//
// Todo 26: the Windows Job Object containment primitive behind the
// `hubfetch_job` Node-API addon.
//
// JobHandle owns exactly two kernel handles (the Job object and an I/O
// completion port) and exposes a JS-facing API whose fallible operations return
// stable typed result objects instead of throwing:
//
//   - assignProcess(pid)     assign a process to the Job (minimum rights)
//   - containsProcess(pid)   IsProcessInJob membership check
//   - activeProcessIds()     JobObjectBasicProcessIdList query
//   - terminate(exitCode)    TerminateJobObject
//   - waitForEmpty(timeoutMs) Promise; waits OFF the JS main thread for
//                            JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO AND a
//                            zero-active-process query
//   - close()                idempotent; also safe from the finalizer
//
// Win32 errors are mapped to stable typed codes (see MapWin32Category) so a
// caller can branch on a string category instead of raw GetLastError values.
// ERROR_ACCESS_DENIED is NEVER swallowed: it surfaces as errorCode
// 'access-denied'.
//
// The completion port is read with a bounded 100 ms slice inside libuv
// threadpool threads, so closing the Job while a wait is pending can never
// block a worker indefinitely: after the slice the loop observes the closed
// flag (or the invalid port) and resolves the wait with the typed `closed`
// result. Handles are released exactly once.
#pragma once

#include <windows.h>

#include <atomic>

#include <napi.h>

namespace hubfetch_job {

// Stable operation-level error codes (load-bearing: asserted by tests/QA and
// surfaced through the main-process loader's typed clone-support gate).
inline constexpr const char* kCodeClosed = "HUBFETCH_JOB_CLOSED";
inline constexpr const char* kCodeInvalidArgument = "HUBFETCH_JOB_INVALID_ARGUMENT";
inline constexpr const char* kCodeOpenProcessFailed = "HUBFETCH_JOB_OPEN_PROCESS_FAILED";
inline constexpr const char* kCodeAssignFailed = "HUBFETCH_JOB_ASSIGN_FAILED";
inline constexpr const char* kCodeQueryFailed = "HUBFETCH_JOB_QUERY_FAILED";
inline constexpr const char* kCodeTerminateFailed = "HUBFETCH_JOB_TERMINATE_FAILED";
inline constexpr const char* kCodeWaitTimeout = "HUBFETCH_JOB_WAIT_TIMEOUT";
inline constexpr const char* kCodeCreateFailed = "HUBFETCH_JOB_CREATE_FAILED";
inline constexpr const char* kCodeLimitFailed = "HUBFETCH_JOB_LIMIT_FAILED";
inline constexpr const char* kCodePortFailed = "HUBFETCH_JOB_PORT_FAILED";

// Stable Win32-error categories. 'access-denied' must never be collapsed into
// a generic fallback.
const char* MapWin32Category(DWORD err);

// Build a `{ok:false, code, errorCode, win32Error, message}` result object.
Napi::Object MakeOpError(Napi::Env env, const char* code, DWORD win32Error, const char* what);

// Same shape, thrown as a pending JS exception (used by createKillOnCloseJob).
void ThrowOpError(Napi::Env env, const char* code, DWORD win32Error, const char* what);

class JobHandle : public Napi::ObjectWrap<JobHandle> {
 public:
  static Napi::FunctionReference constructor;
  static void Init(Napi::Env env, Napi::Object exports);

  // Factory: CreateJobObjectW + JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE + completion
  // port association. Throws a typed error on any failure.
  static Napi::Value CreateKillOnCloseJob(const Napi::CallbackInfo& info);

  JobHandle(const Napi::CallbackInfo& info);
  ~JobHandle() override;
  void Finalize(Napi::Env env) override;

  Napi::Value AssignProcess(const Napi::CallbackInfo& info);
  Napi::Value ContainsProcess(const Napi::CallbackInfo& info);
  Napi::Value ActiveProcessIds(const Napi::CallbackInfo& info);
  Napi::Value Terminate(const Napi::CallbackInfo& info);
  Napi::Value WaitForEmpty(const Napi::CallbackInfo& info);
  Napi::Value Close(const Napi::CallbackInfo& info);

 private:
  bool closed() const { return closed_.load(std::memory_order_acquire); }
  void CloseHandles();

  std::atomic<bool> closed_{false};
  HANDLE job_ = nullptr;
  HANDLE port_ = nullptr;
};

}  // namespace hubfetch_job