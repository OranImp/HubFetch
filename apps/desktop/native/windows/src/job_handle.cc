// apps/desktop/native/windows/src/job_handle.cc
//
// Todo 26: Windows Job Object containment for the `hubfetch_job` addon.
// See job_handle.h for the contract. All fallible operations return stable
// typed result objects; ERROR_ACCESS_DENIED is preserved as errorCode
// 'access-denied' and never collapsed into a generic failure.
#include "job_handle.h"

#include <process.h>
#include <stddef.h>

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <vector>

namespace hubfetch_job {

namespace {

constexpr DWORD kPortSliceMs = 100;      // bounded GetQueuedCompletionStatus slice
constexpr DWORD kMaxTimeoutMs = 86400000;  // 24h hard bound for waitForEmpty
constexpr DWORD kMaxPidList = 4096;      // active-process query bound

}  // namespace

const char* MapWin32Category(DWORD err) {
  switch (err) {
    case ERROR_ACCESS_DENIED:
      return "access-denied";
    case ERROR_INVALID_PARAMETER:
      return "invalid-parameter";
    case ERROR_INVALID_HANDLE:
      return "invalid-handle";
    case ERROR_NOT_FOUND:
      return "not-found";
    case ERROR_ALREADY_EXISTS:
      return "already-exists";
    case ERROR_BUSY:
      return "busy";
    case ERROR_MORE_DATA:
      return "more-data";
    case ERROR_PROCESS_ABORTED:
      return "process-aborted";
    case ERROR_OPERATION_ABORTED:
      return "operation-aborted";
    default:
      return "win32";
  }
}

Napi::Object MakeOpError(Napi::Env env, const char* code, DWORD win32Error, const char* what) {
  Napi::Object o = Napi::Object::New(env);
  o.Set("ok", Napi::Boolean::New(env, false));
  o.Set("code", Napi::String::New(env, code));
  o.Set("errorCode", Napi::String::New(env, MapWin32Category(win32Error)));
  o.Set("win32Error", Napi::Number::New(env, static_cast<double>(win32Error)));
  char message[256];
  std::snprintf(
    message, sizeof(message), "%s (win32 error %lu: %s)", what, win32Error,
    MapWin32Category(win32Error));
  o.Set("message", Napi::String::New(env, message));
  return o;
}

void ThrowOpError(Napi::Env env, const char* code, DWORD win32Error, const char* what) {
  char message[256];
  std::snprintf(
    message, sizeof(message), "%s (win32 error %lu: %s)", what, win32Error,
    MapWin32Category(win32Error));
  Napi::Error err = Napi::Error::New(env, message);
  err.Set("code", Napi::String::New(env, code));
  err.Set("errorCode", Napi::String::New(env, MapWin32Category(win32Error)));
  err.Set("win32Error", Napi::Number::New(env, static_cast<double>(win32Error)));
  err.ThrowAsJavaScriptException();
}

Napi::Object OkResult(Napi::Env env) {
  Napi::Object o = Napi::Object::New(env);
  o.Set("ok", Napi::Boolean::New(env, true));
  return o;
}

Napi::Object ClosedResult(Napi::Env env) {
  return MakeOpError(env, kCodeClosed, ERROR_INVALID_HANDLE, "JobHandle is closed");
}

Napi::Object InvalidArgument(Napi::Env env, const char* what) {
  return MakeOpError(env, kCodeInvalidArgument, ERROR_INVALID_PARAMETER, what);
}

// Validate a pid argument: a finite 32-bit unsigned integer, never 0.
bool CoercePid(const Napi::Value& value, DWORD* out) {
  if (!value.IsNumber()) return false;
  double v = value.As<Napi::Number>().DoubleValue();
  if (!std::isfinite(v)) return false;
  if (v < 1.0 || v > 4294967295.0) return false;
  if (v != static_cast<double>(static_cast<DWORD>(v))) return false;
  *out = static_cast<DWORD>(v);
  return true;
}

// ---------------------------------------------------------------------------
// WaitForEmpty async worker. Runs on a libuv threadpool thread (off the JS
// main thread). Emptiness is proven by JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO
// followed by a zero-active QueryInformationJobObject; a job that is already
// empty resolves immediately (query-confirmed). Bounded by the caller's
// timeout and by 100 ms port-read slices, so a concurrent close can never
// leave a worker blocked indefinitely.
// ---------------------------------------------------------------------------
class EmptyWaiter : public Napi::AsyncWorker {
 public:
  EmptyWaiter(
    Napi::Env env, Napi::Object jobObject, HANDLE job, HANDLE port, DWORD timeoutMs,
    std::atomic<bool>* closed)
      : Napi::AsyncWorker(env, "hubfetch_job:waitForEmpty"),
        jobRef_(Napi::Persistent(jobObject)),
        deferred_(Napi::Promise::Deferred::New(env)),
        job_(job),
        port_(port),
        timeoutMs_(timeoutMs),
        closed_(closed) {}

  Napi::Promise Promise() { return deferred_.Promise(); }

 protected:
  void Execute() override {
    std::memset(&result_, 0, sizeof(result_));
    result_.ok = true;
    if (QueryZeroActive()) return;
    const DWORD start = GetTickCount();
    for (;;) {
      if (closed_->load(std::memory_order_acquire)) {
        SetError(kCodeClosed, "closed", ERROR_INVALID_HANDLE, "JobHandle closed while waiting");
        return;
      }
      const DWORD elapsed = GetTickCount() - start;
      if (elapsed >= timeoutMs_) {
        SetError(
          kCodeWaitTimeout, "timeout", WAIT_TIMEOUT, "Job did not reach zero active processes");
        return;
      }
      DWORD slice = timeoutMs_ - elapsed;
      slice = std::min(slice, kPortSliceMs);
      ULONG_PTR key = 0;
      LPOVERLAPPED overlapped = nullptr;
      DWORD bytes = 0;
      const BOOL got = GetQueuedCompletionStatus(port_, &bytes, &key, &overlapped, slice);
      if (got) {
        if (key == JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO && QueryZeroActive()) return;
        continue;  // other job messages are irrelevant to emptiness
      }
      const DWORD err = GetLastError();
      if (err == WAIT_TIMEOUT) continue;  // slice expired; loop re-checks the deadline
      if (err == ERROR_OPERATION_ABORTED || err == ERROR_INVALID_HANDLE) {
        SetError(kCodeClosed, "closed", err, "completion port closed while waiting");
        return;
      }
      // Unexpected port error: keep looping; the deadline still bounds us.
    }
  }

  void OnOK() override {
    Napi::Env env = Env();
    if (result_.ok) {
      deferred_.Resolve(OkResult(env));
    } else {
      Napi::Object o = Napi::Object::New(env);
      o.Set("ok", Napi::Boolean::New(env, false));
      o.Set("code", Napi::String::New(env, result_.code));
      o.Set("errorCode", Napi::String::New(env, result_.errorCode));
      o.Set("win32Error", Napi::Number::New(env, static_cast<double>(result_.win32Error)));
      o.Set("message", Napi::String::New(env, result_.message));
      deferred_.Resolve(o);
    }
  }

  void OnError(const Napi::Error& e) override { deferred_.Reject(e.Value()); }

 private:
  void SetError(const char* code, const char* category, DWORD win32Error, const char* what) {
    result_.ok = false;
    result_.code = code;
    result_.errorCode = category;
    result_.win32Error = win32Error;
    std::snprintf(result_.message, sizeof(result_.message), "%s", what);
  }

  bool QueryZeroActive() {
    JOBOBJECT_BASIC_PROCESS_ID_LIST list = {};
    DWORD needed = 0;
    const BOOL ok =
      QueryInformationJobObject(job_, JobObjectBasicProcessIdList, &list, sizeof(list), &needed);
    if (!ok) return false;  // handle may be closed; the loop detects it via the closed flag
    return list.NumberOfProcessIdsInList == 0;
  }

  Napi::ObjectReference jobRef_;  // keeps the JobHandle JS object (and its native memory) alive
  Napi::Promise::Deferred deferred_;
  HANDLE job_;
  HANDLE port_;
  DWORD timeoutMs_;
  std::atomic<bool>* closed_;
  struct {
    bool ok;
    const char* code;
    const char* errorCode;
    DWORD win32Error;
    char message[160];
  } result_;
};

// ---------------------------------------------------------------------------
// JobHandle
// ---------------------------------------------------------------------------
Napi::FunctionReference JobHandle::constructor;

JobHandle::JobHandle(const Napi::CallbackInfo& info) : Napi::ObjectWrap<JobHandle>(info) {
  Napi::Env env = info.Env();
  job_ = CreateJobObjectW(nullptr, nullptr);
  if (!job_) {
    ThrowOpError(env, kCodeCreateFailed, GetLastError(), "CreateJobObjectW failed");
    return;
  }
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION jeli = {};
  jeli.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job_, JobObjectExtendedLimitInformation, &jeli, sizeof(jeli))) {
    const DWORD err = GetLastError();
    CloseHandles();
    ThrowOpError(env, kCodeLimitFailed, err, "SetInformationJobObject (kill-on-close) failed");
    return;
  }
  port_ = CreateIoCompletionPort(INVALID_HANDLE_VALUE, nullptr, 0, 0);
  if (!port_) {
    const DWORD err = GetLastError();
    CloseHandles();
    ThrowOpError(env, kCodePortFailed, err, "CreateIoCompletionPort failed");
    return;
  }
  JOBOBJECT_ASSOCIATE_COMPLETION_PORT jacp = {};
  jacp.CompletionKey = job_;  // PVOID; opaque per-instance sentinel, unused by the waiter
  jacp.CompletionPort = port_;
  if (!SetInformationJobObject(job_, JobObjectAssociateCompletionPortInformation, &jacp,
                               sizeof(jacp))) {
    const DWORD err = GetLastError();
    CloseHandles();
    ThrowOpError(env, kCodePortFailed, err, "SetInformationJobObject (completion port) failed");
  }
}

JobHandle::~JobHandle() {
  CloseHandles();
}

void JobHandle::Finalize(Napi::Env /*env*/) {
  CloseHandles();
}

void JobHandle::CloseHandles() {
  if (closed_.exchange(true, std::memory_order_acq_rel)) return;  // released exactly once
  if (job_ != nullptr) {
    CloseHandle(job_);
    job_ = nullptr;
  }
  if (port_ != nullptr) {
    CloseHandle(port_);
    port_ = nullptr;
  }
}

void JobHandle::Init(Napi::Env env, Napi::Object exports) {
  Napi::Function ctor = DefineClass(
    env,
    "HubFetchJob",
    {
      InstanceMethod("assignProcess", &JobHandle::AssignProcess),
      InstanceMethod("containsProcess", &JobHandle::ContainsProcess),
      InstanceMethod("activeProcessIds", &JobHandle::ActiveProcessIds),
      InstanceMethod("terminate", &JobHandle::Terminate),
      InstanceMethod("waitForEmpty", &JobHandle::WaitForEmpty),
      InstanceMethod("close", &JobHandle::Close),
    });
  constructor = Napi::Persistent(ctor);
  constructor.SuppressDestruct();
}

Napi::Value JobHandle::CreateKillOnCloseJob(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object obj = constructor.New({});
  if (env.IsExceptionPending()) return env.Undefined();
  return obj;
}

Napi::Value JobHandle::AssignProcess(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (closed()) return ClosedResult(env);
  DWORD pid = 0;
  if (info.Length() < 1 || !CoercePid(info[0], &pid)) {
    return InvalidArgument(env, "assignProcess(pid) requires a 32-bit unsigned pid");
  }
  // Must NOT assign the current Electron/Node process to the Job.
  if (pid == GetCurrentProcessId()) {
    return MakeOpError(env, kCodeInvalidArgument, ERROR_INVALID_PARAMETER,
                       "refusing to assign the current process to the Job");
  }
  // Minimum rights required to assign a process to a Job.
  HANDLE process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, FALSE, pid);
  if (!process) {
    const DWORD err = GetLastError();
    return MakeOpError(env, kCodeOpenProcessFailed, err, "OpenProcess failed");
  }
  const BOOL ok = AssignProcessToJobObject(job_, process);
  const DWORD err = ok ? 0 : GetLastError();
  CloseHandle(process);
  if (!ok) return MakeOpError(env, kCodeAssignFailed, err, "AssignProcessToJobObject failed");
  return OkResult(env);
}

Napi::Value JobHandle::ContainsProcess(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (closed()) return ClosedResult(env);
  DWORD pid = 0;
  if (info.Length() < 1 || !CoercePid(info[0], &pid)) {
    return InvalidArgument(env, "containsProcess(pid) requires a 32-bit unsigned pid");
  }
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!process) {
    const DWORD err = GetLastError();
    if (err == ERROR_INVALID_PARAMETER) {
      // A PID that cannot exist is not (and never can be) in the Job.
      Napi::Object o = Napi::Object::New(env);
      o.Set("ok", Napi::Boolean::New(env, true));
      o.Set("contains", Napi::Boolean::New(env, false));
      return o;
    }
    return MakeOpError(env, kCodeOpenProcessFailed, err, "OpenProcess failed");
  }
  BOOL inJob = FALSE;
  const BOOL ok = IsProcessInJob(process, job_, &inJob);
  const DWORD err = ok ? 0 : GetLastError();
  CloseHandle(process);
  if (!ok) return MakeOpError(env, kCodeQueryFailed, err, "IsProcessInJob failed");
  Napi::Object o = Napi::Object::New(env);
  o.Set("ok", Napi::Boolean::New(env, true));
  o.Set("contains", Napi::Boolean::New(env, inJob ? true : false));
  return o;
}

Napi::Value JobHandle::ActiveProcessIds(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (closed()) return ClosedResult(env);
  // Two-phase query with a bounded retry: the process list can grow between
  // the sizing call and the data call (e.g. a grandchild being spawned), so
  // ERROR_MORE_DATA is expected and handled by growing the buffer.
  DWORD needed = sizeof(JOBOBJECT_BASIC_PROCESS_ID_LIST);
  for (int attempt = 0; attempt < 4; ++attempt) {
    std::vector<BYTE> buffer(needed);
    auto* list = reinterpret_cast<JOBOBJECT_BASIC_PROCESS_ID_LIST*>(buffer.data());
    if (QueryInformationJobObject(job_, JobObjectBasicProcessIdList, list, needed, &needed)) {
      const DWORD count = list->NumberOfProcessIdsInList;
      Napi::Array pids = Napi::Array::New(env, count);
      for (DWORD i = 0; i < count; ++i) {
        pids.Set(i, Napi::Number::New(env, static_cast<double>(list->ProcessIdList[i])));
      }
      Napi::Object o = Napi::Object::New(env);
      o.Set("ok", Napi::Boolean::New(env, true));
      o.Set("pids", pids);
      return o;
    }
    const DWORD err = GetLastError();
    if (err != ERROR_MORE_DATA) {
      return MakeOpError(env, kCodeQueryFailed, err, "QueryInformationJobObject failed");
    }
    if (needed > sizeof(JOBOBJECT_BASIC_PROCESS_ID_LIST) + kMaxPidList * sizeof(ULONG_PTR)) {
      return MakeOpError(env, kCodeQueryFailed, ERROR_INVALID_PARAMETER,
                         "active process list exceeds the 4096-PID bound");
    }
  }
  return MakeOpError(env, kCodeQueryFailed, ERROR_MORE_DATA,
                     "active process list kept growing across retries");
}

Napi::Value JobHandle::Terminate(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (closed()) return ClosedResult(env);
  DWORD exitCode = 1;
  if (info.Length() >= 1 && info[0].IsNumber()) {
    const double v = info[0].As<Napi::Number>().DoubleValue();
    if (!std::isfinite(v) || v < 0.0 || v > 4294967295.0) {
      return InvalidArgument(env, "terminate(exitCode) requires a 32-bit unsigned exit code");
    }
    exitCode = static_cast<DWORD>(v);
  }
  if (!TerminateJobObject(job_, exitCode)) {
    const DWORD err = GetLastError();
    return MakeOpError(env, kCodeTerminateFailed, err, "TerminateJobObject failed");
  }
  return OkResult(env);
}

Napi::Value JobHandle::WaitForEmpty(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  DWORD timeoutMs = 30000;
  if (info.Length() >= 1 && info[0].IsNumber()) {
    const double v = info[0].As<Napi::Number>().DoubleValue();
    if (!std::isfinite(v) || v < 0.0) {
      Napi::Promise::Deferred d = Napi::Promise::Deferred::New(env);
      d.Resolve(InvalidArgument(env, "waitForEmpty(timeoutMs) requires a non-negative number"));
      return d.Promise();
    }
    timeoutMs = static_cast<DWORD>(std::min(v, static_cast<double>(kMaxTimeoutMs)));
  }
  if (closed()) {
    Napi::Promise::Deferred d = Napi::Promise::Deferred::New(env);
    d.Resolve(ClosedResult(env));
    return d.Promise();
  }
  auto* waiter = new EmptyWaiter(env, info.This().As<Napi::Object>(), job_, port_, timeoutMs,
                                 &closed_);
  waiter->Queue();
  return waiter->Promise();
}

Napi::Value JobHandle::Close(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  CloseHandles();  // idempotent
  return OkResult(env);
}

}  // namespace hubfetch_job