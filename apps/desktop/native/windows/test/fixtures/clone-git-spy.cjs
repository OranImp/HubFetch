// apps/desktop/native/windows/test/fixtures/clone-git-spy.cjs
//
// Todo 27 "git" fixture: stands in for the real Git executable. The worker
// spawns this with the envelope argv. It:
//   - records its invocation (SPAWN line) + its PID into the spy log
//   - spawns a grandchild (clone-git-leaf.cjs) that also logs its PID
//   - emits git-style progress lines to stderr
//   - never exits on its own — only Job termination (SIGKILL via TerminateJobObject)
//     may kill it, proving the worker's Git tree was contained from birth.
//
// Usage: node clone-git-spy.cjs <leafScript>
// Env:   CLONE_SPY_LOG = log file path
'use strict'
const { appendFileSync, existsSync } = require('node:fs')
const { spawn } = require('node:child_process')

const leafScript = process.argv[2]
const logFile = process.env.CLONE_SPY_LOG

function log(line) {
  if (!logFile) return
  try {
    appendFileSync(logFile, `${line}\n`, 'utf8')
  } catch {
    /* best-effort */
  }
}

// Record the Git spawn — the "spy".
log(`SPAWN_PID=${process.pid}`)

// Spawn a grandchild inside the same Job (it inherits the Job membership).
if (leafScript && existsSync(leafScript)) {
  const leaf = spawn(process.execPath, [leafScript], {
    env: { ...process.env, CLONE_SPY_LOG: logFile },
    stdio: 'ignore',
    windowsHide: true
  })
  leaf.on('error', (err) => log(`LEAF_SPAWN_ERROR=${err && err.message}`))
}

// Git-style progress output on stderr.
function progress(phase, pct) {
  process.stderr.write(`${phase}: ${pct}% (${pct * 2}/${pct * 5})\n`)
}

let pct = 0
const timer = setInterval(() => {
  pct = Math.min(100, pct + 5)
  progress('Receiving objects', pct)
  if (pct >= 100) {
    progress('Resolving deltas', 100)
    progress('Checking out files', 100)
  }
}, 20)
timer.unref()

// Keep alive forever; only the Job termination kills this tree.
setInterval(() => {}, 60000).unref()
