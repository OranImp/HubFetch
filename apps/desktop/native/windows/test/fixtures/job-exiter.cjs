// apps/desktop/native/windows/test/fixtures/job-exiter.cjs
//
// Todo 26 integration fixture: exits immediately with the given code
// (default 0). Used to produce a real exited PID for the assignment-failure
// tests (assigning an exited process must fail with a typed error).
'use strict'
const code = Number(process.argv[2] || 0)
process.exit(Number.isInteger(code) ? code : 0)
