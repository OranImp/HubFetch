// apps/desktop/native/windows/test/fixtures/job-leaf.cjs
//
// Todo 26 integration fixture: the "leaf" (grandchild) of the gated tree.
// Stays alive until the Job terminates it, or a 60 s safety timeout fires.
'use strict'
const timer = setInterval(() => {}, 1000)
setTimeout(() => {
  clearInterval(timer)
  process.exit(0)
}, 60000).unref()
