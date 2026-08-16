// apps/desktop/native/windows/test/fixtures/clone-git-leaf.cjs
//
// Todo 27 leaf fixture: the grandchild of the clone worker's Git child. Writes
// its PID to the spy log, then sleeps forever. Must only ever be killed by the
// Job termination (or by the OS); it never exits on its own.
'use strict'
const { appendFileSync } = require('node:fs')

const logFile = process.env.CLONE_SPY_LOG
if (logFile) {
  try {
    appendFileSync(logFile, `LEAF_PID=${process.pid}\n`, 'utf8')
  } catch {
    /* log is best-effort */
  }
}

setInterval(() => {
  // keep alive forever; SIGKILL from the Job is the only exit
}, 60000).unref()
