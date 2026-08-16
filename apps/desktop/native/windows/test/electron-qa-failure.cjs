// apps/desktop/native/windows/test/electron-qa-failure.cjs
//
// Todo 26 QA FAILURE PATH, run under the REAL Electron runtime
// (ELECTRON_RUN_AS_NODE=1, invoked via `pnpm native:test`). Bundles the real
// main-process loader with esbuild and proves that:
//
//   - invalid / exited / access-denied PIDs produce STABLE TYPED failures on
//     a real Job (ERROR_ACCESS_DENIED is preserved, never swallowed)
//   - the clone layer NEVER starts a process when assignment fails: a fake
//     clone host that only spawns Git after a successful assignProcess is
//     invoked against every failure; its spawn counter stays zero
//   - the loader keeps reporting the typed unavailable bridge when the addon
//     is absent (clone support stays disabled), without crashing
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
const exiterFixture = join(__dirname, 'fixtures', 'job-exiter.cjs')

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

function fail(message) {
  console.error(`QA_FAILURE_FAIL ${message}`)
  process.exit(1)
}

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') fail('platform/arch not win32/x64')
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
  if (bridge.status !== 'ready') fail(`loader did not report ready: ${JSON.stringify(bridge)}`)

  // The clone layer contract (Todo 27 shape): it refuses to spawn Git until the
  // bridge successfully assigns the (yet-to-exist) worker PID. Here we simulate
  // it: only a successful assignProcess increments the spawn counter.
  let cloneSpawns = 0
  const cloneHost = {
    spawnGit(assignResult) {
      if (assignResult.ok) cloneSpawns++
    }
  }

  const addon = require(addonPath)
  const job = addon.createKillOnCloseJob()
  const failureCases = []

  // 1. invalid PID (out of the 32-bit space) -> typed open/assign failure.
  const invalid = job.assignProcess(0xffffffff)
  failureCases.push({ name: 'invalid-pid', result: invalid })
  cloneHost.spawnGit(invalid)

  // 2. exited PID: spawn a real process, let it exit, then try to assign.
  const exiter = spawn(process.execPath, [exiterFixture, '42'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'ignore'
  })
  const exitedPid = exiter.pid
  await waitForExit(exiter, 5000)
  const exited = job.assignProcess(exitedPid)
  failureCases.push({ name: 'exited-pid', result: exited })
  cloneHost.spawnGit(exited)

  // 3. access-denied PID (System, PID 4) -> errorCode 'access-denied' preserved.
  const accessDenied = job.assignProcess(4)
  failureCases.push({ name: 'access-denied-pid', result: accessDenied })
  cloneHost.spawnGit(accessDenied)

  // 4. self-assignment refused.
  const selfAssign = job.assignProcess(process.pid)
  failureCases.push({ name: 'self-assignment', result: selfAssign })
  cloneHost.spawnGit(selfAssign)

  // Every failure must be TYPED (stable code + stable errorCode + message) ...
  for (const c of failureCases) {
    if (
      c.result.ok !== false ||
      typeof c.result.code !== 'string' ||
      typeof c.result.errorCode !== 'string' ||
      typeof c.result.message !== 'string'
    ) {
      fail(`case '${c.name}' was not a typed failure: ${JSON.stringify(c.result)}`)
    }
  }
  // ... access-denied must specifically surface as 'access-denied'.
  if (failureCases[2].result.errorCode !== 'access-denied') {
    fail(`access-denied swallowed: ${JSON.stringify(failureCases[2].result)}`)
  }

  // ... and the clone layer must have started ZERO processes.
  if (cloneSpawns !== 0) {
    fail(`clone layer started ${cloneSpawns} process(es) despite failed assignments`)
  }

  // No process is contained after the failed attempts.
  const active = job.activeProcessIds()
  if (!active.ok || active.pids.length !== 0) {
    fail(`Job not empty after failed assignments: ${JSON.stringify(active)}`)
  }
  job.close()

  // 5. loader absent-addon path stays typed-unavailable with clone disabled.
  const missing = loadHubFetchJob({
    overridePath: join(addonPath, 'does-not-exist.node'),
    isPackaged: false,
    appPath: process.cwd(),
    platform: 'win32',
    arch: 'x64',
    modulesVersion: process.versions.modules,
    checkExists: existsSync
  })
  const missingSupport = getCloneSupport(missing)
  if (missing.status !== 'unavailable' || missingSupport.enabled !== false) {
    fail(
      `missing addon did not yield typed unavailable + disabled clone: ${JSON.stringify(missing)}`
    )
  }

  console.log(
    'QA_FAILURE_PASS ' +
      JSON.stringify(
        {
          cases: failureCases.map((c) => ({
            name: c.name,
            code: c.result.code,
            errorCode: c.result.errorCode
          })),
          cloneLayerSpawns: cloneSpawns,
          jobEmptyAfterFailures: active.ok && active.pids.length === 0,
          missingAddon: {
            status: missing.status,
            code: missing.code,
            cloneEnabled: missingSupport.enabled
          }
        },
        null,
        2
      )
  )
}

main().catch((err) => {
  console.error(`QA_FAILURE_FAIL unexpected rejection: ${err && err.message}`)
  process.exit(1)
})
