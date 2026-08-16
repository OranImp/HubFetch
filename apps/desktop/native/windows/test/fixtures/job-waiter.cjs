// apps/desktop/native/windows/test/fixtures/job-waiter.cjs
//
// Todo 26 integration fixture: a contained process that never exits on its
// own. Used by the timeout, containsProcess, and kill-on-close tests. It must
// be terminated by the Job (or killed explicitly) so the test never leaks.
'use strict'
process.stdin.resume()
// Safety net: never leave a live process behind on a failed assertion.
setTimeout(() => process.exit(2), 120000).unref()
