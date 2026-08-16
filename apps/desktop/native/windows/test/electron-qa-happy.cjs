// apps/desktop/native/windows/test/electron-qa-happy.cjs
//
// Todo 26 QA HAPPY PATH, run under the REAL Electron runtime
// (ELECTRON_RUN_AS_NODE=1, invoked via `pnpm native:test`). Bundles the actual
// main-process loader with esbuild, loads the real Electron-ABI addon through
// it, and exercises the full containment loop:
//
//   1. loader reports a ready bridge; getCloneSupport probes a REAL
//      createKillOnCloseJob() and reports clone support ENABLED
//   2. spawn a gated fixture root, assign BEFORE release
//   3. release the gate -> the root spawns a grandchild inside the Job
//   4. wait until two PIDs are visible in the Job (bounded coordination)
//   5. terminate -> waitForEmpty -> zero-active completion (the Job's own proof)
//   6. both PIDs dead; close the Job
'use strict'
const { buildSync } = require('esbuild')
const { spawn } = require('node:child_process')
const { existsSync } = require('node:fs')
const { join } = require('node:path')

const loaderTs = join(
  __dirname,
  '..',
  '..',
  '..',
  'src',
  'main',
  'native',
  'hubfetch-job-loader.ts'
)
const outfile = join(__dirname, '..', 'build', 'qa-loader.cjs')

buildSync({
  entryPoints: [loaderTs],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  outfile,
  logLevel: 'silent'
})

const { getCloneSupport, loadHubFetchJob } = require(outfile)
const addonPath = join(__dirname, '..', 'build', 'Release', 'hubfetch_job.node')
const rootFixture = join(__dirname, 'fixtures', 'job-root.cjs')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = fn()
    if (value) return value
    if (Date.now() >= deadline) throw new Error(`QA_HAPPY waitFor(${label}) timed out`)
    await sleep(20)
  }
}

function fail(message) {
  console.error(`QA_HAPPY_FAIL ${message}`)
  process.exit(1)
}

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    fail('platform/arch not win32/x64')
  }
  if (!existsSync(addonPath)) fail(`addon missing: ${addonPath}`)

  const bridge = loadHubFetchJob({
    overridePath: addonPath,
    isPackaged: false,
    appPath: process.cwd(),
    platform: 'win32',
    arch: 'x64',
    modulesVersion: process.versions.modules,
    checkExists: existsSync
  })

  const report = {
    bridge,
    cloneSupport: null,
    modules: process.versions.modules,
    electron: process.versions.electron ?? 'run-as-node',
    containment: null
  }

  if (bridge.status !== 'ready') fail(`loader did not report ready: ${JSON.stringify(report)}`)
  if (bridge.runtimeInfo.nodeAbi !== Number(process.versions.modules)) fail('ABI mismatch')
  if (bridge.runtimeInfo.arch !== 'x64') fail('arch not x64')

  // getCloneSupport must probe the REAL bridge: a real Job is created, proven
  // usable, and closed again.
  const support = getCloneSupport(bridge)
  report.cloneSupport = support
  if (support.enabled !== true) {
    fail(`clone support not enabled on real bridge: ${JSON.stringify(report)}`)
  }

  // Full containment loop through the loader's addon (probe + real instance).
  const addon = require(addonPath)
  const job = addon.createKillOnCloseJob()
  const root = spawn(process.execPath, [rootFixture], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'pipe', 'inherit']
  })

  const assignRoot = job.assignProcess(root.pid)
  if (!assignRoot.ok) fail(`assign root failed: ${JSON.stringify(assignRoot)}`)
  if (!job.containsProcess(root.pid).contains) fail('root not visible in the Job after assignment')

  // Release the gate; the root spawns the grandchild inside the Job.
  root.stdin.write('GO\n')

  let pids = null
  try {
    pids = await waitFor(
      () => {
        const ids = job.activeProcessIds()
        return ids.ok && ids.pids.length >= 2 ? ids.pids : null
      },
      10000,
      'two-pids'
    )
  } catch (err) {
    fail(`${err.message}; active=${JSON.stringify(job.activeProcessIds())}`)
  }
  const leafPid = pids.find((pid) => pid !== root.pid)
  if (!leafPid || !job.containsProcess(leafPid).contains) {
    fail(`leaf not contained: pids=${JSON.stringify(pids)}`)
  }

  const terminate = job.terminate(0)
  if (!terminate.ok) fail(`terminate failed: ${JSON.stringify(terminate)}`)
  const empty = await job.waitForEmpty(10000)
  if (!empty.ok) fail(`waitForEmpty failed: ${JSON.stringify(empty)}`)
  const activeAfter = job.activeProcessIds()
  if (!activeAfter.ok || activeAfter.pids.length !== 0) {
    fail(`zero-active not confirmed: ${JSON.stringify(activeAfter)}`)
  }
  job.close()

  report.containment = {
    rootPid: root.pid,
    leafPid,
    bothInJob: true,
    terminate: true,
    zeroActiveCompletion: empty.ok,
    zeroActiveQuery: activeAfter.ok && activeAfter.pids.length === 0,
    note: 'emptiness proven by JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO + zero-active query, never by sleep'
  }

  console.log('QA_HAPPY_PASS ' + JSON.stringify(report, null, 2))
}

main().catch((err) => {
  console.error(`QA_HAPPY_FAIL unexpected rejection: ${err && err.message}`)
  process.exit(1)
})
