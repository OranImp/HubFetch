// apps/desktop/native/windows/test/fixtures/job-waiter.cjs
//
// Todo 26 integration fixture: a contained process that never exits on its
// own. Used by the timeout, containsProcess, and kill-on-close tests. It must
// be terminated by the Job (or killed explicitly) so the test never leaks.
'use strict'
// Keep a REFERENCED interval so the event loop stays alive deterministically.
// Relying only on `stdin.resume()` (plus an unref'd safety timer) lets the
// process exit as soon as an ignored/closed stdin ends, which made the
// waitForEmpty-timeout assertion racy depending on whether the process had
// drained before the bounded wait began.
process.stdin.resume()
const keepAlive = setInterval(() => {}, 1000)
// Safety net: never leave a live process behind on a failed assertion.
setTimeout(() => {
  clearInterval(keepAlive)
  process.exit(2)
}, 120000)
