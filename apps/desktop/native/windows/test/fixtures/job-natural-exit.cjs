// apps/desktop/native/windows/test/fixtures/job-natural-exit.cjs
//
// Todo 36 fixture: a process tree whose members exit NATURALLY (no Job
// terminate), reproducing the utility clone worker's flow: root spawns a leaf,
// the leaf exits on its own, then the root exits ~50 ms later (mirroring the
// clone worker's post-terminal exit delay). waitForEmpty started while the
// root is still a live Job member must resolve on the natural drain.
'use strict'
const { spawn } = require('node:child_process')
const { join } = require('node:path')

const leafPath = join(__dirname, 'job-natural-leaf.cjs')
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
  child.on('exit', (code) => {
    // Exit ~50 ms after the leaf, mirroring the clone worker's post-terminal
    // delay, so a waitForEmpty started just before this races the drain.
    setTimeout(() => process.exit(typeof code === 'number' ? code : 0), 50)
  })
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
setTimeout(() => process.exit(2), 30000).unref()
