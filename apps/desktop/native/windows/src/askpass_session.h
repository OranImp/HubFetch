// apps/desktop/native/windows/src/askpass_session.h
//
// Todo 30: the Job-bound one-shot AskPass session behind the `hubfetch_job`
// addon. One session serves exactly one app-token clone: it owns a ZEROIZABLE
// copy of the token (and the username answer), a 256-bit-random named pipe
// whose DACL admits only SYSTEM and the current user, a duplicated handle to
// the clone's Job object, a TTL, a prompt limit, and the allowed username /
// password prompt classes.
//
// The server thread accepts one connection at a time. For every client it:
//   1. obtains the ACTUAL client PID via GetNamedPipeClientProcessId (a
//      client-supplied PID is never trusted — the protocol carries none);
//   2. opens the client with minimum rights and requires IsProcessInJob for
//      the linked Job — a helper outside the Job is rejected with a typed
//      error frame and receives no secret;
//   3. validates session state (open, within TTL, prompt budget, allowed
//      class) before serving `username` or the token as one message.
//
// The token buffer is wiped with SecureZeroMemory only AFTER the server thread
// has been joined, so no thread can touch a freed buffer. The JS side zeroes
// its own copy immediately after the native copy (see askpass-broker.ts).
//
// Win32 failures surface as stable typed error objects (AskPassSessionError)
// with a `code` string; a failed CreateNamedPipe / DACL / duplicate always
// fails the session creation instead of degrading to an insecure pipe.
#pragma once

#include <windows.h>

#include <atomic>
#include <memory>
#include <string>
#include <thread>

#include <napi.h>

namespace hubfetch_job {

// Stable session-state values reported through stats().
inline constexpr int kSessionStateListening = 0;
inline constexpr int kSessionStateClosed = 1;
inline constexpr int kSessionStateExpired = 2;
inline constexpr int kSessionStateLimitReached = 3;

// I/O diagnostics shared with the free helper functions (test/debug only).
struct IoDebug {
  std::atomic<uint32_t> writeFailures{0};
  std::atomic<uint64_t> writeBytes{0};
  std::atomic<uint32_t> lastError{0};
  std::atomic<uint32_t> readFailures{0};
};

// Wire-level error codes sent to the helper inside an 'E' frame.
inline constexpr uint8_t kErrSessionClosed = 0x01;
inline constexpr uint8_t kErrNotInJob = 0x02;
inline constexpr uint8_t kErrClassNotAllowed = 0x03;
inline constexpr uint8_t kErrExpired = 0x04;
inline constexpr uint8_t kErrPromptLimit = 0x05;
inline constexpr uint8_t kErrProtocol = 0x06;
inline constexpr uint8_t kErrInternal = 0x07;

// Request byte the helper sends: username or password prompt class.
inline constexpr BYTE kRequestUsername = 'U';
inline constexpr BYTE kRequestPassword = 'P';

// Server read/write timeouts for one pipe message (bounded, never hang).
inline constexpr DWORD kPipeMessageTimeoutMs = 5000;

// Default session parameters (the broker may override each one).
inline constexpr uint32_t kDefaultPromptLimit = 4;
inline constexpr uint64_t kDefaultSessionTtlMs = 60'000;

class AskPassSession : public Napi::ObjectWrap<AskPassSession> {
 public:
  static Napi::FunctionReference constructor;
  static void Init(Napi::Env env, Napi::Object exports);
  static Napi::Value Create(const Napi::CallbackInfo& info);

  AskPassSession(const Napi::CallbackInfo& info);
  ~AskPassSession() override;
  void Finalize(Napi::Env env) override;

  Napi::Value Close(const Napi::CallbackInfo& info);
  Napi::Value Stats(const Napi::CallbackInfo& info);
  Napi::Value ZeroizeProof(const Napi::CallbackInfo& info);

 private:
  void StartServerThread();
  void ServerLoop();
  void StopAndZeroize();

  // Duplicate the caller's Job object handle with the session's own access.
  void DuplicateJobHandle(Napi::Env env, Napi::Object jobObject);

  std::wstring pipe_name_;
  std::wstring pipe_path_;
  // The current-user+SYSTEM DACL applied to every pipe instance (built once at
  // creation, surfaced through stats().pipeDaclSddl for the test suite).
  PSECURITY_DESCRIPTOR dacl_sd_ = nullptr;
  std::string dacl_sddl_;
  HANDLE job_dup_ = nullptr;
  std::unique_ptr<BYTE[]> token_;  // zeroizable copy
  size_t token_len_ = 0;
  std::unique_ptr<BYTE[]> username_;  // zeroizable copy
  size_t username_len_ = 0;
  bool allow_username_ = true;
  bool allow_password_ = true;
  uint32_t prompt_limit_ = kDefaultPromptLimit;
  uint64_t ttl_ms_ = kDefaultSessionTtlMs;
  int64_t created_at_ms_ = 0;

  std::thread server_thread_;
  std::atomic<bool> closed_{false};
  std::atomic<int32_t> state_{kSessionStateListening};
  std::atomic<uint32_t> connections_{0};
  std::atomic<uint32_t> prompts_served_{0};
  std::atomic<uint32_t> rejected_{0};
  // Stable code of the most recent rejection (0x00 = none), for tests/diagnosis.
  std::atomic<uint32_t> last_reject_reason_{0};
  // I/O counters for the debug paths (exposed via stats()['debug']).
  IoDebug io_debug_;
  // Handle of the currently-connected pipe instance so Close() can cancel an
  // in-flight overlapped operation before joining the server thread.
  std::atomic<HANDLE> current_pipe_{nullptr};
};

}  // namespace hubfetch_job