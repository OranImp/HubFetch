// apps/desktop/native/windows/test/fixtures/job-root.cjs
//
// Todo 26 integration fixture: the "root" of a gated process tree.
//
// Waits for a single "GO" line on stdin, THEN spawns the leaf with the same
// executable, prints `LEAF_PID=<pid>` to stdout, and waits for the leaf to
// exit before exiting itself. The test assigns this process to a Job BEFORE
// writing "GO", so the leaf is born inside the Job (Windows children inherit
// Job membership). The event gate makes the assignment race-free.
'use strict'
const { spawn } = require('node:child_process')
const { join } = require('node:path')

const leafPath = join(__dirname, 'job-leaf.cjs')
let buffer = ''
let released = false

function maybeRelease() {
  if (released) return
  const line = buffer.split('\n')[0].trim()
  if (line !== 'GO') return
  released = true
  const child = spawn(process.execPath, [leafPath], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'ignore'
  })
  process.stdout.write(`LEAF_PID=${child.pid}\n`)
  child.on('exit', (code) => process.exit(typeof code === 'number' ? code : 0))
  child.on('error', (err) => {
    process.stderr.write(`LEAF_SPAWN_ERROR ${err.message}\n`)
    process.exit(3)
  })
}

process.stdin.on('data', (chunk) => {
  buffer += chunk.toString()
  maybeRelease()
})
process.stdin.on('end', () => maybeRelease())
process.stdin.resume()

// Safety net: never let the fixture outlive the test run indefinitely.
setTimeout(() => process.exit(2), 60000).unref()
