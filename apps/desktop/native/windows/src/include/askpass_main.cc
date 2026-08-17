// apps/desktop/native/windows/src/include/askpass_main.cc
//
// Todo 30: HubFetchAskPass.exe — the packaged console helper Git spawns via
// `GIT_ASKPASS` for app-token clones. It resolves the answer for ONE prompt
// from the Job-bound AskPass session in the HubFetch main process, over a
// named pipe whose locator arrives in `HUBFETCH_ASKPASS_PIPE`.
//
// Contract:
//   - the helper is a console-subsystem x64 PE (asserted by packaging tests);
//   - Git passes exactly one prompt as argv[1]; anything else is a usage
//     error (exit 1) — nothing is ever echoed;
//   - prompts are classified structurally (username / password / unknown);
//     an unknown class is refused (exit 1) instead of answered;
//   - every pipe operation is bounded by an overall deadline; if the server is
//     unavailable, refuses, or disconnects, the helper prints ONLY a fixed
//     sanitized message to stderr and exits nonzero (2/3/4) — the token is
//     NEVER printed on failure;
//   - on success the answer is printed to stdout followed by a newline (Git
//     strips the trailing line ending and only reads the first line);
//   - all buffers holding the answer are zeroed before exit.
//
// Protocol (byte-mode pipe):
//   helper -> server: one byte 'U' | 'P'
//   server -> helper: [status:1] [len:4 LE] [payload]
//     'O' payload = answer bytes
//     'E' payload = [error code:1] + utf8 detail
#include <windows.h>

#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cwctype>
#include <string>
#include <vector>

namespace {

constexpr wchar_t kPipeVariable[] = L"HUBFETCH_ASKPASS_PIPE";
constexpr int64_t kOverallDeadlineMs = 15000;
constexpr DWORD kWaitSliceMs = 200;
constexpr uint32_t kMaxFramePayload = 64 * 1024;

constexpr int kExitOk = 0;
constexpr int kExitUsage = 1;
constexpr int kExitPipeUnavailable = 2;
constexpr int kExitServerRefused = 3;
constexpr int kExitProtocol = 4;
constexpr int kExitInternal = 5;

// Map a server error code to a helper exit code (fail closed, no secret).
int ExitCodeForServerCode(uint8_t code) {
  switch (code) {
    case 0x01:  // session closed
    case 0x02:  // not-in-job
    case 0x03:  // class not allowed
    case 0x04:  // expired
    case 0x05:  // prompt limit
      return kExitServerRefused;
    case 0x06:  // protocol
      return kExitProtocol;
    default:
      return kExitInternal;
  }
}

int64_t NowMs() {
  return static_cast<int64_t>(
    std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now().time_since_epoch())
      .count());
}

enum class PromptClass { Username, Password, Unknown };

bool StartsWith(const std::wstring& text, const wchar_t* prefix) {
  const size_t prefixLen = wcslen(prefix);
  if (text.size() < prefixLen) return false;
  return text.compare(0, prefixLen, prefix) == 0;
}

bool EndsWith(const std::wstring& text, const wchar_t* suffix) {
  const size_t suffixLen = wcslen(suffix);
  if (text.size() < suffixLen) return false;
  return text.compare(text.size() - suffixLen, suffixLen, suffix) == 0;
}

bool Contains(const std::wstring& text, const wchar_t* needle) {
  return text.find(needle) != std::wstring::npos;
}

// Structural classification mirrors the archived HubFetch prompts.py: only
// prompt shapes the helper provably owns are answered; everything else is
// UNKNOWN and refused.
PromptClass ClassifyPrompt(const wchar_t* rawPrompt) {
  std::wstring folded;
  if (rawPrompt != nullptr) folded.assign(rawPrompt);
  for (wchar_t& c : folded) c = static_cast<wchar_t>(towlower(c));
  // strip leading/trailing whitespace
  size_t begin = folded.find_first_not_of(L" \t\r\n");
  if (begin == std::wstring::npos) return PromptClass::Unknown;
  size_t end = folded.find_last_not_of(L" \t\r\n");
  folded = folded.substr(begin, end - begin + 1);
  if (StartsWith(folded, L"username")) return PromptClass::Username;
  if (EndsWith(folded, L"'s password:")) return PromptClass::Password;
  if (Contains(folded, L"password for '") && EndsWith(folded, L"':"))
    return PromptClass::Password;
  if (StartsWith(folded, L"enter passphrase for key '")) return PromptClass::Password;
  return PromptClass::Unknown;
}

bool WaitForHandle(HANDLE handle, int64_t deadline) {
  for (;;) {
    const int64_t now = NowMs();
    if (now >= deadline) return false;
    const DWORD remain = static_cast<DWORD>(deadline - now);
    const DWORD wait = WaitForSingleObject(handle, remain < kWaitSliceMs ? remain : kWaitSliceMs);
    if (wait == WAIT_OBJECT_0) return true;
    if (wait == WAIT_FAILED) return false;
  }
}

// Read one full message (message-mode pipe) within the deadline. Message-mode
// pipes deliver each WriteFile as one atomic message, so a single read returns
// the whole response — no framing loop needed. Returns false on timeout/close.
bool ReadOneMessage(HANDLE pipe, BYTE* buffer, DWORD bufferSize, DWORD* bytesRead,
                    int64_t deadline) {
  OVERLAPPED ov = {};
  ov.hEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (ov.hEvent == nullptr) return false;
  DWORD n = 0;
  BOOL ok = ReadFile(pipe, buffer, bufferSize, &n, &ov);
  DWORD err = ok ? ERROR_SUCCESS : GetLastError();
  bool success = false;
  if (ok && n > 0) {
    *bytesRead = n;
    success = true;
  } else if (ok && n == 0) {
    // server closed the pipe without data
  } else if (err == ERROR_IO_PENDING) {
    if (WaitForHandle(ov.hEvent, deadline) && GetOverlappedResult(pipe, &ov, &n, FALSE) &&
        n > 0) {
      *bytesRead = n;
      success = true;
    } else {
      CancelIoEx(pipe, &ov);
    }
  } else if (err == ERROR_MORE_DATA) {
    // The response exceeds the buffer — a protocol violation.
  }
  CloseHandle(ov.hEvent);
  return success;
}

bool WriteExact(HANDLE pipe, const BYTE* data, DWORD length, int64_t deadline) {
  DWORD offset = 0;
  while (offset < length) {
    OVERLAPPED ov = {};
    ov.hEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (ov.hEvent == nullptr) return false;
    DWORD n = 0;
    BOOL ok = WriteFile(pipe, data + offset, length - offset, &n, &ov);
    const DWORD err = ok ? ERROR_SUCCESS : GetLastError();
    if (ok && n > 0) {
      offset += n;
      CloseHandle(ov.hEvent);
      continue;
    }
    if (err == ERROR_IO_PENDING) {
      if (WaitForHandle(ov.hEvent, deadline) &&
          GetOverlappedResult(pipe, &ov, &n, FALSE) && n > 0) {
        offset += n;
        CloseHandle(ov.hEvent);
        continue;
      }
      CancelIoEx(pipe, &ov);
    }
    CloseHandle(ov.hEvent);
    return false;
  }
  return true;
}

// Connect to the session pipe within the deadline; retries ERROR_PIPE_BUSY
// (the server re-creates its instance between connections).
HANDLE ConnectPipe(const std::wstring& pipePath, int64_t deadline) {
  for (;;) {
    if (NowMs() >= deadline) return INVALID_HANDLE_VALUE;
    HANDLE pipe = CreateFileW(pipePath.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr,
                              OPEN_EXISTING, FILE_FLAG_OVERLAPPED, nullptr);
    if (pipe != INVALID_HANDLE_VALUE) return pipe;
    const DWORD err = GetLastError();
    if (err == ERROR_PIPE_BUSY) {
      WaitNamedPipeW(pipePath.c_str(), kWaitSliceMs);
      continue;
    }
    // ERROR_FILE_NOT_FOUND and friends mean the server is gone (or never was).
    if (err == ERROR_FILE_NOT_FOUND || err == ERROR_PATH_NOT_FOUND ||
        err == ERROR_BAD_PATHNAME) {
      return INVALID_HANDLE_VALUE;
    }
    Sleep(50);
  }
}

int Run(int argc, wchar_t** argv) {
  if (argc != 2) {
    fwprintf(stderr, L"askpass: expected exactly one prompt argument\n");
    return kExitUsage;
  }
  const PromptClass kind = ClassifyPrompt(argv[1]);
  if (kind == PromptClass::Unknown) {
    fwprintf(stderr, L"askpass: unrecognized prompt class; refusing to answer\n");
    return kExitUsage;
  }

  const wchar_t* locator = _wgetenv(kPipeVariable);
  if (locator == nullptr || locator[0] == L'\0') {
    fwprintf(stderr, L"askpass: no pipe locator configured\n");
    return kExitUsage;
  }
  const std::wstring pipePath = std::wstring(L"\\\\.\\pipe\\") + locator;

  const int64_t deadline = NowMs() + kOverallDeadlineMs;
  HANDLE pipe = ConnectPipe(pipePath, deadline);
  if (pipe == INVALID_HANDLE_VALUE) {
    fwprintf(stderr, L"askpass: credential server is not available\n");
    return kExitPipeUnavailable;
  }

  const BYTE request = kind == PromptClass::Username ? 'U' : 'P';
  if (!WriteExact(pipe, &request, 1, deadline)) {
    CloseHandle(pipe);
    fwprintf(stderr, L"askpass: credential server is not available\n");
    return kExitPipeUnavailable;
  }

  // Message-mode read: the server sends the whole [status][len][payload] frame
  // as ONE message, which arrives atomically even if the server disconnects
  // right after writing.
  DWORD mode = PIPE_READMODE_MESSAGE;
  SetNamedPipeHandleState(pipe, &mode, nullptr, nullptr);

  constexpr DWORD kMaxFrameBytes = 5 + kMaxFramePayload;
  std::vector<BYTE> frame(kMaxFrameBytes);
  DWORD frameBytes = 0;
  if (!ReadOneMessage(pipe, frame.data(), kMaxFrameBytes, &frameBytes, deadline) ||
      frameBytes < 5) {
    CloseHandle(pipe);
    fwprintf(stderr, L"askpass: credential server closed the pipe\n");
    return kExitProtocol;
  }
  const BYTE status = frame[0];
  const uint32_t len =
    static_cast<uint32_t>(frame[1]) | (static_cast<uint32_t>(frame[2]) << 8) |
    (static_cast<uint32_t>(frame[3]) << 16) | (static_cast<uint32_t>(frame[4]) << 24);
  if (frameBytes != 5 + len || len > kMaxFramePayload) {
    CloseHandle(pipe);
    fwprintf(stderr, L"askpass: malformed response from credential server\n");
    return kExitProtocol;
  }
  if (status == 'O') {
    if (len > 0) {
      fwrite(frame.data() + 5, 1, len, stdout);
    }
    fputc('\n', stdout);
    fflush(stdout);
    SecureZeroMemory(frame.data(), frame.size());
    CloseHandle(pipe);
    return kExitOk;
  }
  if (status == 'E') {
    BYTE code = len > 0 ? frame[5] : 0;
    SecureZeroMemory(frame.data(), frame.size());
    CloseHandle(pipe);
    fwprintf(stderr, L"askpass: credential server refused the request (code 0x%02X)\n", code);
    return ExitCodeForServerCode(code);
  }

  SecureZeroMemory(frame.data(), frame.size());
  CloseHandle(pipe);
  fwprintf(stderr, L"askpass: malformed response from credential server\n");
  return kExitProtocol;
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  return Run(argc, argv);
}