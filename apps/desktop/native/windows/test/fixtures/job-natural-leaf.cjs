// apps/desktop/native/windows/test/fixtures/job-natural-leaf.cjs
//
// Todo 36 fixture: the "leaf" of a naturally-exiting tree. Exits on its own
// after a short bounded delay, so the whole tree drains without any Job
// terminate (mirrors a git child finishing and exiting).
'use strict'
setTimeout(() => process.exit(0), 300).unref()
