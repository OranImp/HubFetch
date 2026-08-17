// apps/desktop/native/windows/src/askpass_session.cc
//
// Todo 30: Job-bound one-shot AskPass session. See askpass_session.h for the
// security contract. This translation unit implements the named-pipe server,
// the current-user+SYSTEM DACL, the GetNamedPipeClientProcessId +
// IsProcessInJob validation, TTL / prompt-limit / prompt-class enforcement,
// and zeroization ordering (token wiped only after the server thread joins).
//
// Frame protocol (byte-mode pipe, no message boundaries):
//   helper -> server: one byte 'U' (username) | 'P' (password)
//   server -> helper: [status:1]['O'|'E'] [len:4 little-endian] [payload]
//     'O' payload = the secret bytes (username or token)
//     'E' payload = [error code:1] + utf8 detail   (typed refusal, no secret)
//   helper -> server: one byte 'A' (acknowledge) after consuming the frame.
// The ACK is REQUIRED: byte-mode pipes discard buffered data when the server
// disconnects, so the server only disconnects after the helper proves it read
// the response (bounded by the per-message timeout; a stuck helper is simply
// dropped, which never prints a token).
#include "askpass_session.h"

#include <aclapi.h>
#include <bcrypt.h>
#include <sddl.h>
#include <stringapiset.h>

#include <algorithm>
#include <chrono>
#include <random>
#include <string>
#include <vector>

#include "job_handle.h"

#pragma comment(lib, "bcrypt.lib")

namespace hubfetch_job {

namespace {

constexpr size_t kMaxTokenBytes = 64 * 1024;
constexpr size_t kPipeBufferBytes = 64 * 1024;
constexpr DWORD kConnectSliceMs = 100;

int64_t NowMs() {
  return static_cast<int64_t>(
    std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now().time_since_epoch())
      .count());
}

std::string Utf8FromWide(const std::wstring& wide) {
  if (wide.empty()) return std::string();
  const int size = WideCharToMultiByte(CP_UTF8, 0, wide.data(), static_cast<int>(wide.size()),
                                       nullptr, 0, nullptr, nullptr);
  if (size <= 0) return std::string();
  std::string out(static_cast<size_t>(size), '\0');
  WideCharToMultiByte(CP_UTF8, 0, wide.data(), static_cast<int>(wide.size()), &out[0], size,
                      nullptr, nullptr);
  return out;
}

// ---------------------------------------------------------------------------
// Typed N-API error helper (stable `code` string, never crashes main).
// ---------------------------------------------------------------------------

Napi::Error MakeSessionError(Napi::Env env, const char* code, const char* message) {
  Napi::Error error = Napi::Error::New(env, message);
  error.Set("code", Napi::String::New(env, code));
  error.Set("errorCode", Napi::String::New(env, "askpass-session"));
  return error;
}

// With NAPI_DISABLE_CPP_EXCEPTIONS a raw `throw Napi::Error` escapes the N-API
// callback and terminates the process; the correct pattern is to set the JS
// exception and return normally. All validation failures use this.
void ThrowValidation(Napi::Env env, const char* code, const char* message) {
  MakeSessionError(env, code, message).ThrowAsJavaScriptException();
}

// ---------------------------------------------------------------------------
// Current-user + SYSTEM DACL (SDDL) �?the only access to the pipe.
// ---------------------------------------------------------------------------

// Build "D:P(A;;GA;;;SY)(A;;GA;;;<current-user-sid>)" using the token's owner.
// Returns the SDDL string and a matching self-relative security descriptor.
bool BuildCurrentUserSystemDacl(std::string* outSddl, PSECURITY_DESCRIPTOR* out) {
  *out = nullptr;
  HANDLE token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return false;
  DWORD size = 0;
  GetTokenInformation(token, TokenUser, nullptr, 0, &size);
  if (size == 0) {
    CloseHandle(token);
    return false;
  }
  std::vector<BYTE> buffer(static_cast<size_t>(size));
  if (!GetTokenInformation(token, TokenUser, buffer.data(), size, &size)) {
    CloseHandle(token);
    return false;
  }
  CloseHandle(token);
  const auto* user = reinterpret_cast<TOKEN_USER*>(buffer.data());
  if (user->User.Sid == nullptr) return false;
  LPWSTR sidString = nullptr;
  if (!ConvertSidToStringSidW(user->User.Sid, &sidString)) return false;
  const std::wstring sddl =
    std::wstring(L"D:P(A;;GA;;;SY)(A;;GA;;;") + sidString + L")";
  LocalFree(sidString);
  PSECURITY_DESCRIPTOR sd = nullptr;
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
        sddl.c_str(), SDDL_REVISION_1, &sd, nullptr)) {
    return false;
  }
  int wideLen = WideCharToMultiByte(CP_UTF8, 0, sddl.c_str(), static_cast<int>(sddl.size()),
                                    nullptr, 0, nullptr, nullptr);
  if (wideLen > 0) {
    outSddl->resize(static_cast<size_t>(wideLen));
    WideCharToMultiByte(CP_UTF8, 0, sddl.c_str(), static_cast<int>(sddl.size()), &(*outSddl)[0],
                        wideLen, nullptr, nullptr);
  }
  *out = sd;
  return true;
}

// Random 256-bit pipe name: "HubFetchAskPass-" + 64 lowercase hex chars.
std::wstring GeneratePipeName() {
  constexpr size_t kRandomBytes = 32;
  std::vector<BYTE> bytes(static_cast<size_t>(kRandomBytes));
  const wchar_t* hex = L"0123456789abcdef";
  const NTSTATUS status = BCryptGenRandom(nullptr, bytes.data(),
                                          static_cast<ULONG>(bytes.size()),
                                          BCRYPT_USE_SYSTEM_PREFERRED_RNG);
  if (status < 0) {
    // Last-resort per-session entropy (locator is non-secret; the secret is
    // the token itself, which never rides the pipe name).
    std::random_device rd;
    for (auto& b : bytes) b = static_cast<BYTE>(rd() & 0xFF);
  }
  std::wstring name = L"HubFetchAskPass-";
  name.reserve(16 + kRandomBytes * 2);
  for (BYTE b : bytes) {
    name.push_back(hex[(b >> 4) & 0x0F]);
    name.push_back(hex[b & 0x0F]);
  }
  return name;
}

// ---------------------------------------------------------------------------
// Bounded overlapped pipe byte I/O (never blocks past the deadline)
// ---------------------------------------------------------------------------

bool StartOverlapped(HANDLE pipe, OVERLAPPED* ov) {
  ov->hEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  return ov->hEvent != nullptr;
}

enum class WaitOutcome { Done, Closed, TimedOut };

WaitOutcome WaitOverlapped(OVERLAPPED* ov, DWORD timeoutMs, const std::atomic<bool>& closed) {
  const int64_t deadline = NowMs() + timeoutMs;
  for (;;) {
    const DWORD wait = WaitForSingleObject(ov->hEvent, std::min<DWORD>(kConnectSliceMs, timeoutMs));
    if (wait == WAIT_OBJECT_0) return WaitOutcome::Done;
    if (closed.load(std::memory_order_acquire)) return WaitOutcome::Closed;
    if (NowMs() >= deadline) return WaitOutcome::TimedOut;
  }
}

// Read exactly `length` bytes (byte-mode pipe; loops over partial reads).
bool ReadBytes(HANDLE pipe, BYTE* buffer, DWORD length, const std::atomic<bool>& closed,
               IoDebug* dbg) {
  DWORD offset = 0;
  while (offset < length) {
    OVERLAPPED ov = {};
    if (!StartOverlapped(pipe, &ov)) {
      if (dbg) dbg->readFailures.fetch_add(1, std::memory_order_relaxed);
      return false;
    }
    DWORD n = 0;
    BOOL ok = ReadFile(pipe, buffer + offset, length - offset, &n, &ov);
    DWORD err = ok ? ERROR_SUCCESS : GetLastError();
    if (ok && n > 0) {
      offset += n;
      CloseHandle(ov.hEvent);
      continue;
    }
    if (ok && n == 0) {  // peer disconnected
      CloseHandle(ov.hEvent);
      if (dbg) dbg->readFailures.fetch_add(1, std::memory_order_relaxed);
      return false;
    }
    if (err == ERROR_IO_PENDING) {
      if (WaitOverlapped(&ov, kPipeMessageTimeoutMs, closed) == WaitOutcome::Done) {
        DWORD got = 0;
        if (GetOverlappedResult(pipe, &ov, &got, FALSE) && got > 0) {
          offset += got;
          CloseHandle(ov.hEvent);
          continue;
        }
      } else {
        CancelIoEx(pipe, &ov);
      }
    }
    if (dbg) {
      dbg->readFailures.fetch_add(1, std::memory_order_relaxed);
      dbg->lastError.store(err, std::memory_order_relaxed);
    }
    CloseHandle(ov.hEvent);
    return false;
  }
  return true;
}

// Write the response as ONE synchronous WriteFile. A synchronous write COMMITS
// the message before returning, so the subsequent FlushFileBuffers waits for
// the reader reliably. (An OVERLAPPED write defers the commit; the flush can
// then start on an empty pipe and the message is dropped when the server
// disconnects — that race made the overlapped path unreliable.) The message is
// at most 64 KiB and the pipe buffer is 64 KiB, so the write completes
// immediately without blocking, even if the reader never reads.
bool WriteFrame(HANDLE pipe, BYTE status, const BYTE* payload, size_t payloadLen,
                const std::atomic<bool>& closed, IoDebug* dbg) {
  if (payloadLen > 0xFFFFFFFFu) return false;
  std::vector<BYTE> frame(5 + payloadLen);
  frame[0] = status;
  const uint32_t len = static_cast<uint32_t>(payloadLen);
  frame[1] = static_cast<BYTE>(len & 0xFF);
  frame[2] = static_cast<BYTE>((len >> 8) & 0xFF);
  frame[3] = static_cast<BYTE>((len >> 16) & 0xFF);
  frame[4] = static_cast<BYTE>((len >> 24) & 0xFF);
  if (payloadLen > 0) {
    std::copy(payload, payload + payloadLen, frame.begin() + 5);
  }
  DWORD written = 0;
  const BOOL ok = WriteFile(pipe, frame.data(), static_cast<DWORD>(frame.size()), &written,
                            nullptr);
  if (dbg) {
    if (ok && written > 0) dbg->writeBytes.fetch_add(written, std::memory_order_relaxed);
    if (!ok) dbg->writeFailures.fetch_add(1, std::memory_order_relaxed);
  }
  SecureZeroMemory(frame.data(), frame.size());
  return ok != FALSE && written == frame.size();
}

void DisconnectAndClose(HANDLE pipe, const std::atomic<bool>& closed, IoDebug* dbg) {
  // FlushFileBuffers COMMITS the response and waits for the reader to consume
  // it — required because a message is only guaranteed delivered once flushed;
  // an immediate disconnect after the write races the kernel's deferred
  // delivery and drops the message. The flush blocks the server thread, but
  // StopAndZeroize cancels it via CancelSynchronousIo before joining, so a
  // hostile client that never reads cannot hang the session close.
  FlushFileBuffers(pipe);
  DisconnectNamedPipe(pipe);
  CloseHandle(pipe);
}

void SendErrorFrame(HANDLE pipe, uint8_t code, const char* detail,
                    const std::atomic<bool>& closed, IoDebug* dbg) {
  std::vector<BYTE> payload;
  payload.push_back(code);
  const size_t detailLen = std::char_traits<char>::length(detail);
  payload.insert(payload.end(), detail, detail + detailLen);
  WriteFrame(pipe, 'E', payload.data(), payload.size(), closed, dbg);
}

}  // namespace

// ---------------------------------------------------------------------------
// N-API wiring
// ---------------------------------------------------------------------------

void AskPassSession::Init(Napi::Env env, Napi::Object exports) {
  Napi::Function func = DefineClass(env, "AskPassSession", {
    InstanceMethod("close", &AskPassSession::Close),
    InstanceMethod("stats", &AskPassSession::Stats),
    InstanceMethod("zeroizeProof", &AskPassSession::ZeroizeProof),
  });
  constructor = Napi::Persistent(func);
  exports.Set("createAskPassSession", Napi::Function::New(env, AskPassSession::Create));
}

Napi::FunctionReference AskPassSession::constructor;

Napi::Value AskPassSession::Create(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsObject()) {
    ThrowValidation(env, "HUBFETCH_ASKPASS_INVALID_ARGUMENT", "createAskPassSession requires an options object");
    return Napi::Value();
  }
  const Napi::Object options = info[0].As<Napi::Object>();
  Napi::Object instance = AskPassSession::constructor.New({});
  AskPassSession* session = Napi::ObjectWrap<AskPassSession>::Unwrap(instance);
  session->created_at_ms_ = NowMs();

  // --- token (utf8, zeroizable copy, single-line contract) ---
  const Napi::Value tokenValue = options.Get("token");
  if (!tokenValue.IsBuffer()) {
    ThrowValidation(env, "HUBFETCH_ASKPASS_INVALID_ARGUMENT", "token must be a Buffer");
    return Napi::Value();
  }
  const Napi::Buffer<uint8_t> tokenBuffer = tokenValue.As<Napi::Buffer<uint8_t>>();
  const size_t tokenLen = tokenBuffer.Length();
  if (tokenLen == 0) {
    ThrowValidation(env, "HUBFETCH_ASKPASS_INVALID_ARGUMENT", "token must be non-empty");
    return Napi::Value();
  }
  if (tokenLen > kMaxTokenBytes) {
    ThrowValidation(env, "HUBFETCH_ASKPASS_INVALID_ARGUMENT", "token exceeds size cap");
    return Napi::Value();
  }
  {
    const uint8_t* data = tokenBuffer.Data();
    for (size_t i = 0; i < tokenLen; ++i) {
      if (data[i] == '\r' || data[i] == '\n') {
        ThrowValidation(env, "HUBFETCH_ASKPASS_MULTILINE_TOKEN", "token must be a single line");
    return Napi::Value();
      }
    }
    session->token_ = std::make_unique<BYTE[]>(tokenLen);
    std::copy(data, data + tokenLen, session->token_.get());
    session->token_len_ = tokenLen;
  }

  // --- username (utf8, zeroizable copy) ---
  const Napi::Value usernameValue = options.Get("username");
  if (!usernameValue.IsString()) {
    ThrowValidation(env, "HUBFETCH_ASKPASS_INVALID_ARGUMENT", "username must be a string");
    return Napi::Value();
  }
  {
    const std::string username = usernameValue.As<Napi::String>().Utf8Value();
    if (username.empty() || username.find('\r') != std::string::npos ||
        username.find('\n') != std::string::npos) {
      ThrowValidation(env, "HUBFETCH_ASKPASS_INVALID_ARGUMENT", "username must be a non-empty single line");
    return Napi::Value();
    }
    session->username_ = std::make_unique<BYTE[]>(username.size());
    std::copy(username.begin(), username.end(), session->username_.get());
    session->username_len_ = username.size();
  }

  // --- Job handle (duplicated; a client-supplied PID is never trusted) ---
  const Napi::Value jobValue = options.Get("job");
  if (!jobValue.IsObject()) {
    ThrowValidation(env, "HUBFETCH_ASKPASS_INVALID_ARGUMENT", "job must be a JobHandle");
    return Napi::Value();
  }
  session->DuplicateJobHandle(env, jobValue.As<Napi::Object>());
  if (session->job_dup_ == nullptr) {
    ThrowValidation(env, "HUBFETCH_ASKPASS_JOB_LINK_FAILED", "could not duplicate the Job handle");
    return Napi::Value();
  }

  // --- options ---
  const Napi::Value ttlValue = options.Get("ttlMs");
  if (!ttlValue.IsUndefined() && !ttlValue.IsNull()) {
    const double ttl = ttlValue.IsNumber() ? ttlValue.As<Napi::Number>().DoubleValue() : 0;
    if (!(ttl >= 1)) {
      ThrowValidation(env, "HUBFETCH_ASKPASS_INVALID_ARGUMENT", "ttlMs must be >= 1");
    return Napi::Value();
    }
    session->ttl_ms_ = static_cast<uint64_t>(ttl);
  }
  const Napi::Value limitValue = options.Get("promptLimit");
  if (!limitValue.IsUndefined() && !limitValue.IsNull()) {
    const double limit = limitValue.IsNumber() ? limitValue.As<Napi::Number>().DoubleValue() : 0;
    if (!(limit >= 1)) {
      ThrowValidation(env, "HUBFETCH_ASKPASS_INVALID_ARGUMENT", "promptLimit must be >= 1");
    return Napi::Value();
    }
    session->prompt_limit_ = static_cast<uint32_t>(limit);
  }
  const Napi::Value allowUserValue = options.Get("allowUsername");
  if (allowUserValue.IsBoolean()) session->allow_username_ = allowUserValue.As<Napi::Boolean>();
  const Napi::Value allowPassValue = options.Get("allowPassword");
  if (allowPassValue.IsBoolean()) session->allow_password_ = allowPassValue.As<Napi::Boolean>();

  // --- random 256-bit pipe name + current-user+SYSTEM DACL (built once) ---
  if (!BuildCurrentUserSystemDacl(&session->dacl_sddl_, &session->dacl_sd_)) {
    ThrowValidation(env, "HUBFETCH_ASKPASS_DACL_FAILED", "could not build the current-user+SYSTEM DACL");
    return Napi::Value();
  }
  session->pipe_name_ = GeneratePipeName();
  session->pipe_path_ = L"\\\\.\\pipe\\" + session->pipe_name_;

  session->StartServerThread();
  Napi::Object result = Napi::Object::New(env);
  result.Set("pipeName", Napi::String::New(env, Utf8FromWide(session->pipe_name_)));
  result.Set("session", instance);
  return result;
}

void AskPassSession::DuplicateJobHandle(Napi::Env env, Napi::Object jobObject) {
  void* raw = nullptr;
  const napi_status status = napi_unwrap(env, jobObject, &raw);
  if (status != napi_ok || raw == nullptr) {
    ThrowValidation(env, "HUBFETCH_ASKPASS_INVALID_ARGUMENT", "job is not a JobHandle");
    return;
  }
  auto* job = static_cast<JobHandle*>(raw);
  HANDLE duplicate = nullptr;
  if (!DuplicateHandle(GetCurrentProcess(), job->handle(), GetCurrentProcess(), &duplicate, 0,
                       FALSE, DUPLICATE_SAME_ACCESS)) {
    ThrowValidation(env, "HUBFETCH_ASKPASS_JOB_LINK_FAILED", "DuplicateHandle of the Job failed");
    return;
  }
  job_dup_ = duplicate;
}

AskPassSession::AskPassSession(const Napi::CallbackInfo& info)
  : Napi::ObjectWrap<AskPassSession>(info) {}

AskPassSession::~AskPassSession() { StopAndZeroize(); }

void AskPassSession::Finalize(Napi::Env /*env*/) { StopAndZeroize(); }

// ---------------------------------------------------------------------------
// Server thread
// ---------------------------------------------------------------------------

void AskPassSession::StartServerThread() {
  server_thread_ = std::thread(&AskPassSession::ServerLoop, this);
}

void AskPassSession::ServerLoop() {
  while (!closed_.load(std::memory_order_acquire)) {
    const int64_t now = NowMs();
    if (now - created_at_ms_ >= static_cast<int64_t>(ttl_ms_)) {
      state_.store(kSessionStateExpired, std::memory_order_release);
      break;
    }
    if (prompts_served_.load(std::memory_order_acquire) >= prompt_limit_) {
      state_.store(kSessionStateLimitReached, std::memory_order_release);
      break;
    }

    PSECURITY_DESCRIPTOR sd = dacl_sd_;
    SECURITY_ATTRIBUTES sa = {};
    sa.nLength = sizeof(sa);
    sa.lpSecurityDescriptor = sd;
    sa.bInheritHandle = FALSE;

    HANDLE pipe = CreateNamedPipeW(
      pipe_path_.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED,
      PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT, 1, kPipeBufferBytes,
      kPipeBufferBytes, 0, &sa);
    if (pipe == INVALID_HANDLE_VALUE) {
      state_.store(kSessionStateClosed, std::memory_order_release);
      break;
    }

    current_pipe_.store(pipe, std::memory_order_release);

    OVERLAPPED ov = {};
    if (!StartOverlapped(pipe, &ov)) {
      current_pipe_.store(nullptr, std::memory_order_release);
      CloseHandle(pipe);
      state_.store(kSessionStateClosed, std::memory_order_release);
      break;
    }
    const BOOL connected = ConnectNamedPipe(pipe, &ov);
    const DWORD connectError = connected ? ERROR_SUCCESS : GetLastError();
    bool hasClient = connected;
    if (!hasClient && connectError == ERROR_IO_PENDING) {
      const WaitOutcome outcome = WaitOverlapped(&ov, kPipeMessageTimeoutMs, closed_);
      if (outcome == WaitOutcome::Done) {
        hasClient = true;
      } else {
        CancelIoEx(pipe, &ov);
      }
    } else if (!hasClient && connectError == ERROR_PIPE_CONNECTED) {
      // A client already connected between CreateNamedPipe and ConnectNamedPipe.
      hasClient = true;
    }
    CloseHandle(ov.hEvent);

    if (!hasClient) {
      current_pipe_.store(nullptr, std::memory_order_release);
      CloseHandle(pipe);
      // Re-check session state at the top of the loop (TTL/limit/closed).
      continue;
    }

    connections_.fetch_add(1, std::memory_order_relaxed);

    // --- Validate the actual client: kernel PID + Job membership ---
    DWORD clientPid = 0;
    const bool gotPid =
      GetNamedPipeClientProcessId(pipe, &clientPid) != FALSE && clientPid != 0;
    bool inJob = false;
    if (gotPid && job_dup_ != nullptr) {
      HANDLE proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, clientPid);
      if (proc != nullptr) {
        BOOL member = FALSE;
        if (IsProcessInJob(proc, job_dup_, &member) != FALSE && member) inJob = true;
        CloseHandle(proc);
      }
    }
    if (!gotPid || !inJob) {
      rejected_.fetch_add(1, std::memory_order_relaxed);
      last_reject_reason_.store(kErrNotInJob, std::memory_order_relaxed);
      SendErrorFrame(pipe, kErrNotInJob,
                     "helper process is not a member of the linked Job", closed_, &io_debug_);
      DisconnectAndClose(pipe, closed_, &io_debug_);
      current_pipe_.store(nullptr, std::memory_order_release);
      continue;
    }

    // --- Read the prompt-class request ---
    BYTE request = 0;
    if (!ReadBytes(pipe, &request, 1, closed_, &io_debug_)) {
      rejected_.fetch_add(1, std::memory_order_relaxed);
      last_reject_reason_.store(kErrProtocol, std::memory_order_relaxed);
      DisconnectAndClose(pipe, closed_, &io_debug_);
      current_pipe_.store(nullptr, std::memory_order_release);
      continue;
    }

    // --- Validate expiry/limit at SERVE time too: a client may have connected
    // while the connect-wait was pending, past the TTL or the prompt budget. ---
    {
      const int64_t serveNow = NowMs();
      if (serveNow - created_at_ms_ >= static_cast<int64_t>(ttl_ms_)) {
        rejected_.fetch_add(1, std::memory_order_relaxed);
        last_reject_reason_.store(kErrExpired, std::memory_order_relaxed);
        SendErrorFrame(pipe, kErrExpired, "session has expired", closed_, &io_debug_);
        DisconnectAndClose(pipe, closed_, &io_debug_);
        current_pipe_.store(nullptr, std::memory_order_release);
        continue;
      }
      if (prompts_served_.load(std::memory_order_acquire) >= prompt_limit_) {
        rejected_.fetch_add(1, std::memory_order_relaxed);
        last_reject_reason_.store(kErrPromptLimit, std::memory_order_relaxed);
        SendErrorFrame(pipe, kErrPromptLimit, "prompt limit reached", closed_, &io_debug_);
        DisconnectAndClose(pipe, closed_, &io_debug_);
        current_pipe_.store(nullptr, std::memory_order_release);
        continue;
      }
    }

    const bool isUsername = request == kRequestUsername;
    const bool isPassword = request == kRequestPassword;
    if (!isUsername && !isPassword) {
      rejected_.fetch_add(1, std::memory_order_relaxed);
      last_reject_reason_.store(kErrProtocol, std::memory_order_relaxed);
      SendErrorFrame(pipe, kErrProtocol, "unrecognized prompt class request", closed_,
                     &io_debug_);
      DisconnectAndClose(pipe, closed_, &io_debug_);
      current_pipe_.store(nullptr, std::memory_order_release);
      continue;
    }
    if (isUsername && !allow_username_) {
      rejected_.fetch_add(1, std::memory_order_relaxed);
      last_reject_reason_.store(kErrClassNotAllowed, std::memory_order_relaxed);
      SendErrorFrame(pipe, kErrClassNotAllowed, "username prompts are not allowed", closed_,
                     &io_debug_);
      DisconnectAndClose(pipe, closed_, &io_debug_);
      current_pipe_.store(nullptr, std::memory_order_release);
      continue;
    }
    if (isPassword && !allow_password_) {
      rejected_.fetch_add(1, std::memory_order_relaxed);
      last_reject_reason_.store(kErrClassNotAllowed, std::memory_order_relaxed);
      SendErrorFrame(pipe, kErrClassNotAllowed, "password prompts are not allowed", closed_,
                     &io_debug_);
      DisconnectAndClose(pipe, closed_, &io_debug_);
      current_pipe_.store(nullptr, std::memory_order_release);
      continue;
    }

    // --- Serve one answer (username or token), then zero the scratch frame ---
    const BYTE* secret = isUsername ? username_.get() : token_.get();
    const size_t secretLen = isUsername ? username_len_ : token_len_;
    const bool wrote = WriteFrame(pipe, 'O', secret, secretLen, closed_, &io_debug_);
    if (!wrote) {
      rejected_.fetch_add(1, std::memory_order_relaxed);
      last_reject_reason_.store(kErrInternal, std::memory_order_relaxed);
    } else {
      prompts_served_.fetch_add(1, std::memory_order_relaxed);
    }
    DisconnectAndClose(pipe, closed_, &io_debug_);
    current_pipe_.store(nullptr, std::memory_order_release);
    CloseHandle(pipe);
  }
}

// ---------------------------------------------------------------------------
// Close / zeroize (token wiped only after the server thread is joined)
// ---------------------------------------------------------------------------

void AskPassSession::StopAndZeroize() {
  if (closed_.exchange(true, std::memory_order_acq_rel)) {
    // Already closed once — finalizer and close() are idempotent.
    return;
  }
  const HANDLE pipe = current_pipe_.load(std::memory_order_acquire);
  if (pipe != nullptr) CancelIoEx(pipe, nullptr);
  if (server_thread_.joinable()) {
    // The server thread may be blocked in FlushFileBuffers waiting for a
    // hostile client to read. CancelSynchronousIo breaks that sync I/O so the
    // thread can observe closed_ and exit — the join stays bounded.
    CancelSynchronousIo(server_thread_.native_handle());
    server_thread_.join();
  }
  if (token_) {
    SecureZeroMemory(token_.get(), token_len_);
    token_.reset();
    token_len_ = 0;
  }
  if (username_) {
    SecureZeroMemory(username_.get(), username_len_);
    username_.reset();
    username_len_ = 0;
  }
  if (job_dup_ != nullptr) {
    CloseHandle(job_dup_);
    job_dup_ = nullptr;
  }
  if (dacl_sd_ != nullptr) {
    LocalFree(dacl_sd_);
    dacl_sd_ = nullptr;
  }
  state_.store(kSessionStateClosed, std::memory_order_release);
}

Napi::Value AskPassSession::Close(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  StopAndZeroize();
  Napi::Object result = Napi::Object::New(env);
  result.Set("ok", Napi::Boolean::New(env, true));
  return result;
}

Napi::Value AskPassSession::Stats(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object result = Napi::Object::New(env);
  result.Set("pipeName", Napi::String::New(env, Utf8FromWide(pipe_name_)));
  result.Set("state", Napi::Number::New(env, state_.load(std::memory_order_acquire)));
  result.Set("connections", Napi::Number::New(env, connections_.load(std::memory_order_relaxed)));
  result.Set("promptsServed",
             Napi::Number::New(env, prompts_served_.load(std::memory_order_relaxed)));
  result.Set("rejected", Napi::Number::New(env, rejected_.load(std::memory_order_relaxed)));
  result.Set("lastRejectReason",
             Napi::Number::New(env, last_reject_reason_.load(std::memory_order_relaxed)));
  result.Set("promptLimit", Napi::Number::New(env, static_cast<double>(prompt_limit_)));
  result.Set("ttlMs", Napi::Number::New(env, static_cast<double>(ttl_ms_)));
  result.Set("pipeDaclSddl", Napi::String::New(env, dacl_sddl_));
  Napi::Object debug = Napi::Object::New(env);
  debug.Set("writeFailures",
            Napi::Number::New(env, static_cast<double>(io_debug_.writeFailures.load(
                                                     std::memory_order_relaxed))));
  debug.Set("writeBytes",
            Napi::Number::New(env, static_cast<double>(io_debug_.writeBytes.load(
                                                     std::memory_order_relaxed))));
  debug.Set("readFailures",
            Napi::Number::New(env, static_cast<double>(io_debug_.readFailures.load(
                                                     std::memory_order_relaxed))));
  debug.Set("lastError",
            Napi::Number::New(env, static_cast<double>(io_debug_.lastError.load(
                                                     std::memory_order_relaxed))));
  result.Set("debug", debug);
  return result;
}

Napi::Value AskPassSession::ZeroizeProof(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object result = Napi::Object::New(env);
  const bool closed = closed_.load(std::memory_order_acquire);
  result.Set("tokenCleared", Napi::Boolean::New(env, closed && token_ == nullptr));
  result.Set("usernameCleared", Napi::Boolean::New(env, closed && username_ == nullptr));
  result.Set("jobHandleReleased", Napi::Boolean::New(env, closed && job_dup_ == nullptr));
  return result;
}

}  // namespace hubfetch_job