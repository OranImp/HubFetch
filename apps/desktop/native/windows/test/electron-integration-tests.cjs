// apps/desktop/native/windows/test/electron-integration-tests.cjs
//
// Todo 26 native tests — part 2: integration + lifecycle safety under the REAL
// Electron runtime (ELECTRON_RUN_AS_NODE=1, `pnpm native:test`). Requires
// --expose-gc for the finalizer-safety section (native-test.mjs passes it).
//
// Covers the acceptance criteria:
//   - child + grandchild spawned gated by events, both appear in the Job
//   - terminate -> waitForEmpty -> zero active + both PIDs dead
//   - assignment failure / timeout / double-close / finalizer are all safe
//   - no handle growth over 100 create/close cycles
//   - close() with kill-on-close terminates contained processes
//
// No arbitrary sleeps are used as PROOF: emptiness is always proven by the
// Job's own completion-port message plus a zero-active query (waitForEmpty).
// Bounded event/handle polling is used only for coordination (e.g. waiting
// until the fixture tree has spawned).
'use strict'
const { spawn } = require('node:child_process')
const { existsSync } = require('node:fs')
const { join } = require('node:path')

const addonPath = join(__dirname, '..', 'build', 'Release', 'hubfetch_job.node')
const fixtures = join(__dirname, 'fixtures')

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail ?? '' })
  if (!ok) {
    console.error(`FAIL ${name}: ${detail}`)
    process.exit(1)
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Bounded wait: poll `fn` every 20 ms until it returns truthy or the deadline
// (in ms) passes. This is coordination, never containment proof.
async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = fn()
    if (value) return value
    if (Date.now() >= deadline) throw new Error(`waitFor(${label}) timed out after ${timeoutMs}ms`)
    await sleep(20)
  }
}

function spawnNode(script, args = [], stdio = ['ignore', 'pipe', 'inherit']) {
  return spawn(process.execPath, [script, ...args], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio
  })
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    if (err && err.code === 'EPERM') return true // exists but not ours
    return false // ESRCH (or anything else) => gone
  }
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
    child.once('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
  })
}

function assertTypedFailure(result, allowedCodes, label) {
  check(
    label,
    result.ok === false &&
      typeof result.code === 'string' &&
      typeof result.errorCode === 'string' &&
      typeof result.message === 'string' &&
      allowedCodes.includes(result.code),
    JSON.stringify(result)
  )
}

async function main() {
  if (!existsSync(addonPath)) check('addon-path', false, addonPath)
  const addon = require(addonPath)
  const rootFixture = join(fixtures, 'job-root.cjs')
  const waiterFixture = join(fixtures, 'job-waiter.cjs')
  const exiterFixture = join(fixtures, 'job-exiter.cjs')

  // -------------------------------------------------------------
  // 1. Happy path: gated child+grandchild tree, terminate, zero active.
  // -------------------------------------------------------------
  const job = addon.createKillOnCloseJob()
  check(
    'job-methods',
    [
      'assignProcess',
      'containsProcess',
      'activeProcessIds',
      'terminate',
      'waitForEmpty',
      'close'
    ].every((m) => typeof job[m] === 'function')
  )

  const root = spawnNode(rootFixture, [], ['pipe', 'pipe', 'inherit'])
  const rootPid = root.pid
  check('root-spawned', rootPid > 0, String(rootPid))

  // Assign BEFORE releasing the gate so the grandchild is born inside the Job.
  const assignRoot = job.assignProcess(rootPid)
  check('assign-root', assignRoot.ok === true, JSON.stringify(assignRoot))
  const containsRoot = job.containsProcess(rootPid)
  check(
    'contains-root',
    containsRoot.ok === true && containsRoot.contains === true,
    JSON.stringify(containsRoot)
  )

  // Release the gate: the root spawns the leaf (grandchild).
  root.stdin.write('GO\n')

  // Wait until two PIDs are visible in the Job (bounded coordination poll).
  let treePids = null
  try {
    treePids = await waitFor(
      () => {
        const ids = job.activeProcessIds()
        return ids.ok && ids.pids.length >= 2 ? ids.pids : null
      },
      10000,
      'two-pids-in-job'
    )
  } catch (err) {
    check(
      'two-pids-in-job',
      false,
      `${err.message}; active=${JSON.stringify(job.activeProcessIds())}`
    )
  }
  check('two-pids-visible', treePids !== null, 'fixture tree never appeared in the Job')
  const leafPid = treePids.find((pid) => pid !== rootPid)
  check('leaf-pid-found', Number.isInteger(leafPid) && leafPid > 0, JSON.stringify(treePids))

  const containsLeaf = job.containsProcess(leafPid)
  check(
    'contains-leaf',
    containsLeaf.ok === true && containsLeaf.contains === true,
    JSON.stringify(containsLeaf)
  )

  // Cross-check the leaf PID reported by the root fixture on stdout.
  let rootStdout = ''
  root.stdout.on('data', (chunk) => {
    rootStdout += chunk.toString()
  })
  await waitFor(() => rootStdout.includes('LEAF_PID='), 5000, 'root-leaf-report').catch(() => null)
  const reportedLeaf = Number.parseInt((/LEAF_PID=(\d+)/.exec(rootStdout) || [])[1] || '0', 10)
  check('root-reported-leaf', reportedLeaf > 0, `stdout=${JSON.stringify(rootStdout)}`)
  check(
    'reported-leaf-matches-job',
    reportedLeaf === leafPid,
    `reported=${reportedLeaf}, job=${leafPid}`
  )

  // Terminate -> zero-active completion.
  const terminate = job.terminate(7)
  check('terminate', terminate.ok === true, JSON.stringify(terminate))
  const empty = await job.waitForEmpty(10000)
  check('waitForEmpty-after-terminate', empty.ok === true, JSON.stringify(empty))
  check(
    'waitForEmpty-time-proven',
    empty.ok === true,
    'zero proof = completion-port msg + zero-active query'
  )

  const activeAfter = job.activeProcessIds()
  check(
    'zero-active-after-terminate',
    activeAfter.ok === true && activeAfter.pids.length === 0,
    JSON.stringify(activeAfter)
  )

  const rootExited = await waitForExit(root, 5000)
  check('root-exited', rootExited, 'root PID did not exit after Job termination')

  // Belt-and-suspenders: the kernel should reap both PIDs (bounded).
  try {
    await waitFor(
      () => !isProcessAlive(rootPid) && !isProcessAlive(leafPid),
      5000,
      'both-pids-dead'
    )
    check('both-pids-dead', true, `root=${rootPid} leaf=${leafPid}`)
  } catch {
    check(
      'both-pids-dead',
      false,
      `root alive=${isProcessAlive(rootPid)}, leaf alive=${isProcessAlive(leafPid)}`
    )
  }
  job.close()

  // -------------------------------------------------------------
  // 2. waitForEmpty TIMEOUT (bounded) with a live contained process.
  // -------------------------------------------------------------
  const timeoutJob = addon.createKillOnCloseJob()
  const waiter = spawnNode(waiterFixture)
  const waiterPid = waiter.pid
  const assignWaiter = timeoutJob.assignProcess(waiterPid)
  check('timeout-assign', assignWaiter.ok === true, JSON.stringify(assignWaiter))
  const waitResult = await timeoutJob.waitForEmpty(300)
  assertTypedFailure(waitResult, ['HUBFETCH_JOB_WAIT_TIMEOUT'], 'wait-timeout-typed')
  check(
    'timeout-elapsed',
    waitResult.win32Error === 258 || waitResult.errorCode === 'timeout',
    JSON.stringify(waitResult)
  )
  const terminateWaiter = timeoutJob.terminate(0)
  check('timeout-cleanup-terminate', terminateWaiter.ok === true, JSON.stringify(terminateWaiter))
  const waiterEmpty = await timeoutJob.waitForEmpty(10000)
  check('timeout-cleanup-empty', waiterEmpty.ok === true, JSON.stringify(waiterEmpty))
  const waiterExited = await waitForExit(waiter, 5000)
  check('timeout-cleanup-exited', waiterExited, 'waiter survived cleanup')
  timeoutJob.close()

  // -------------------------------------------------------------
  // 3. kill-on-close: closing the Job terminates contained processes.
  // -------------------------------------------------------------
  const kocJob = addon.createKillOnCloseJob()
  const kocWaiter = spawnNode(waiterFixture)
  const kocAssign = kocJob.assignProcess(kocWaiter.pid)
  check('koc-assign', kocAssign.ok === true, JSON.stringify(kocAssign))
  kocJob.close() // last handle close => JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE fires
  const kocExited = await waitForExit(kocWaiter, 5000)
  check(
    'kill-on-close-terminated',
    kocExited,
    'contained process survived Job close (kill-on-close missing?)'
  )
  if (!kocExited) kocWaiter.kill()

  // -------------------------------------------------------------
  // 4. Assignment FAILURE cases: typed errors, nothing started.
  // -------------------------------------------------------------
  const failJob = addon.createKillOnCloseJob()

  // 4a. exited PID: spawn a process, await its exit, then try to assign it.
  const exiter = spawnNode(exiterFixture, ['42'])
  const exitedPid = exiter.pid
  const exiterDone = await waitForExit(exiter, 5000)
  check('exiter-exited', exiterDone, 'fixture did not exit')
  const assignExited = failJob.assignProcess(exitedPid)
  assertTypedFailure(
    assignExited,
    ['HUBFETCH_JOB_OPEN_PROCESS_FAILED', 'HUBFETCH_JOB_ASSIGN_FAILED'],
    'assign-exited-pid-typed'
  )

  // 4b. invalid PID: bounds + OpenProcess failure mapped.
  const assignInvalid = failJob.assignProcess(0xffffffff)
  assertTypedFailure(
    assignInvalid,
    ['HUBFETCH_JOB_OPEN_PROCESS_FAILED'],
    'assign-invalid-pid-typed'
  )

  // 4c. access-denied PID (System): must be preserved, never swallowed.
  const assignSystem = failJob.assignProcess(4)
  check(
    'assign-access-denied',
    assignSystem.ok === false && assignSystem.errorCode === 'access-denied',
    JSON.stringify(assignSystem)
  )

  // 4d. self-assignment is refused.
  const assignSelf = failJob.assignProcess(process.pid)
  check(
    'assign-self-refused',
    assignSelf.ok === false && assignSelf.code === 'HUBFETCH_JOB_INVALID_ARGUMENT',
    JSON.stringify(assignSelf)
  )

  // No process may have been started by these failure paths: the Job is still empty.
  const failActive = failJob.activeProcessIds()
  check(
    'failure-no-process-started',
    failActive.ok === true && failActive.pids.length === 0,
    JSON.stringify(failActive)
  )
  failJob.close()

  // -------------------------------------------------------------
  // 5. double-close + operations-after-close are safe.
  // -------------------------------------------------------------
  const dcJob = addon.createKillOnCloseJob()
  const dc1 = dcJob.close()
  const dc2 = dcJob.close()
  check('double-close-ok', dc1.ok === true && dc2.ok === true, JSON.stringify({ dc1, dc2 }))
  const afterCloseAssign = dcJob.assignProcess(1234)
  check(
    'after-close-typed',
    afterCloseAssign.ok === false && afterCloseAssign.code === 'HUBFETCH_JOB_CLOSED',
    JSON.stringify(afterCloseAssign)
  )
  const afterCloseActive = dcJob.activeProcessIds()
  check(
    'after-close-active-typed',
    afterCloseActive.ok === false && afterCloseActive.code === 'HUBFETCH_JOB_CLOSED',
    JSON.stringify(afterCloseActive)
  )
  const afterCloseWait = await dcJob.waitForEmpty(50)
  check(
    'after-close-wait-typed',
    afterCloseWait.ok === false && afterCloseWait.code === 'HUBFETCH_JOB_CLOSED',
    JSON.stringify(afterCloseWait)
  )

  // -------------------------------------------------------------
  // 6. finalizer safety: drop references, force GC, expect no crash and no
  //    sustained handle growth.
  // -------------------------------------------------------------
  check('expose-gc-available', typeof global.gc === 'function', 'run with --expose-gc')
  for (let i = 0; i < 5; i++) addon.createKillOnCloseJob().close() // warm up
  global.gc()
  global.gc()
  const finalizeBaseline = addon.getProcessHandleCount()
  for (let i = 0; i < 50; i++) addon.createKillOnCloseJob() // never closed explicitly
  global.gc()
  global.gc()
  global.gc()
  let finalizeAfter = addon.getProcessHandleCount()
  const finalizeDeadline = Date.now() + 5000
  while (Date.now() < finalizeDeadline && finalizeAfter > finalizeBaseline + 16) {
    await sleep(100)
    global.gc()
    finalizeAfter = addon.getProcessHandleCount()
  }
  const finalizeSettled = finalizeAfter <= finalizeBaseline + 16
  check(
    'finalizer-released-handles',
    finalizeSettled,
    `baseline=${finalizeBaseline}, after=${finalizeAfter} (50 unclosed jobs must be finalized without crash)`
  )

  // -------------------------------------------------------------
  // 7. no handle growth over 100 create/close cycles.
  // -------------------------------------------------------------
  const growthBaseline = addon.getProcessHandleCount()
  for (let i = 0; i < 100; i++) {
    const j = addon.createKillOnCloseJob()
    j.close()
  }
  const growthAfter = addon.getProcessHandleCount()
  check(
    'no-handle-growth-100-cycles',
    growthAfter - growthBaseline <= 8,
    `before=${growthBaseline}, after=${growthAfter}`
  )

  // 8. async waitForEmpty cycles do not leak handles either.
  const asyncBaseline = addon.getProcessHandleCount()
  for (let i = 0; i < 25; i++) {
    const j = addon.createKillOnCloseJob()
    const w = await j.waitForEmpty(100) // empty job -> immediate ok
    check(`async-cycle-${i}-ok`, w.ok === true, JSON.stringify(w))
    j.close()
  }
  const asyncAfter = addon.getProcessHandleCount()
  check(
    'no-handle-growth-async-waits',
    asyncAfter - asyncBaseline <= 16,
    `before=${asyncBaseline}, after=${asyncAfter}`
  )

  console.log(
    'INTEGRATION_TESTS_PASS ' +
      JSON.stringify(
        { checks: results.length, failures: results.filter((r) => !r.ok).length },
        null,
        2
      )
  )
}

main().catch((err) => {
  console.error('INTEGRATION_TESTS_FAIL unexpected rejection:', err)
  process.exit(1)
})
