// apps/desktop/native/windows/test/electron-job-natural-exit.cjs
//
// Todo 36 focused native regression: waitForEmpty must resolve promptly when
// a Job's last contained process exits NATURALLY (not via Job termination),
// even when waitForEmpty is started while that process is still alive in the
// Job (the utility clone worker's 50 ms exit-delay window that the host's
// proveZero observes).
//
// Reproduces the Todo 36 H1/H2 hang: the real clone worker emits `terminal`,
// then exits ~50 ms later; the host calls waitForEmpty immediately, when the
// worker is still a Job member. If the native EmptyWaiter consumes the
// ACTIVE_PROCESS_ZERO completion-port message while QueryZeroActive() still
// sees the dying process, it never observes zero again and blocks until its
// timeout. This suite proves that does not happen (bounded, no arbitrary
// proof-sleeps).
'use strict'
const { spawn } = require('node:child_process')
const { existsSync } = require('node:fs')
const { join } = require('node:path')

const addonPath = join(__dirname, '..', 'build', 'Release', 'hubfetch_job.node')
const rootFixture = join(__dirname, 'fixtures', 'job-natural-exit.cjs')
const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail ?? '' })
  if (!ok) {
    console.error(`FAIL ${name}: ${detail}`)
    process.exit(1)
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = fn()
    if (value) return value
    if (Date.now() >= deadline) throw new Error(`waitFor(${label}) timed out`)
    await sleep(20)
  }
}

async function main() {
  if (!existsSync(addonPath)) check('addon-path', false, addonPath)
  const addon = require(addonPath)

  const job = addon.createKillOnCloseJob()
  const root = spawn(process.execPath, [rootFixture], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'pipe', 'inherit']
  })
  const rootPid = root.pid
  const assign = job.assignProcess(rootPid)
  check('assign-root', assign.ok === true, JSON.stringify(assign))
  const contains = job.containsProcess(rootPid)
  check('contains-root', contains.ok && contains.contains, JSON.stringify(contains))

  // Start waitForEmpty IMMEDIATELY, while the root is still a live Job member
  // (the exact proveZero timing). Do NOT await it yet.
  const w0 = Date.now()
  const waiterPromise = job.waitForEmpty(10000)

  // Release the gate: root spawns the leaf inside the Job; when the leaf
  // exits, the root exits too. Both exit NATURALLY (no Job terminate).
  let rootStdout = ''
  root.stdout.on('data', (c) => (rootStdout += c.toString()))
  root.stdin.write('GO\n')

  // Wait for the leaf to appear in the Job (coordination poll only).
  const leafPid = await waitFor(
    () => {
      const ids = job.activeProcessIds()
      return ids.ok && ids.pids.length >= 2 ? ids.pids.find((p) => p !== rootPid) : null
    },
    10000,
    'leaf-in-job'
  )
  check('leaf-in-job', Number.isInteger(leafPid) && leafPid > 0, JSON.stringify(leafPid))

  // waitForEmpty must resolve WELL within its 10 s bound (it should fire on
  // natural exit, ~<1 s). Measure how long it actually takes.
  const waiter = await waiterPromise
  const elapsed = Date.now() - w0
  check('waitForEmpty-ok', waiter.ok === true, JSON.stringify(waiter))
  check(
    'waitForEmpty-prompt',
    elapsed < 8000,
    `natural-exit waitForEmpty took ${elapsed}ms (should be prompt, <8s)`
  )

  // Zero-active after natural exit.
  const active = job.activeProcessIds()
  check(
    'zero-active-after-natural-exit',
    active.ok && active.pids.length === 0,
    JSON.stringify(active)
  )

  // Both PIDs gone (bounded).
  const rootExited = await waitFor(() => root.exitCode !== null, 5000, 'root-exit')
  check('root-exited', rootExited, 'root did not exit')

  job.close()
  console.log('NATURAL_EXIT_PASS ' + JSON.stringify({ results, elapsedMs: elapsed }))
  process.exit(0)
}

main().catch((err) => {
  console.error('FAIL unexpected: ' + (err && err.stack))
  process.exit(1)
})
