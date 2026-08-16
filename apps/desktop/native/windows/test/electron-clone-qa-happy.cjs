// apps/desktop/native/windows/test/electron-clone-qa-happy.cjs
//
// Todo 27 QA HAPPY PATH under the REAL Electron main runtime (invoked by
// `pnpm native:test` without ELECTRON_RUN_AS_NODE, so utilityProcess.fork is
// real). Runs the actual CloneHost + real worker bundle + real Job bridge with a
// git-spy fixture:
//
//   1. loader -> ready bridge; getCloneSupport probes the real addon (ENABLED)
//   2. CloneHost.startClone with a fixture envelope whose `git` is the Electron
//      binary running as node (ELECTRON_RUN_AS_NODE=1) -> clone-git-spy.cjs,
//      which spawns a grandchild and emits progress
//   3. message order spawn -> ready -> assign -> contains -> arm -> start proven
//      by the returned record's steps
//   4. progress events are received (typed)
//   5. cooperative cancel -> grace -> Job terminate -> waitForEmpty -> zero
//   6. spy log proves the Git child DID spawn (SPAWN_PID) and the grandchild
//      (LEAF_PID); after cancel both PIDs are dead and the Job is empty
//
// Prints QA_HAPPY_PASS JSON; exits non-zero on any failure.
'use strict'
const { app, utilityProcess } = require('electron')
const { buildSync } = require('esbuild')
const { existsSync, mkdirSync, readFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const here = __dirname
const root = join(here, '..', '..', '..') // apps/desktop
const srcWorker = join(root, 'src', 'utility', 'clone-worker.ts')
const srcHost = join(root, 'src', 'main', 'clone', 'clone-host.ts')
const loaderTs = join(root, 'src', 'main', 'native', 'hubfetch-job-loader.ts')
const addonPath = join(here, '..', 'build', 'Release', 'hubfetch_job.node')
const gitSpy = join(here, 'fixtures', 'clone-git-spy.cjs')
const gitLeaf = join(here, 'fixtures', 'clone-git-leaf.cjs')
const buildDir = join(here, '..', 'build')

const workDir = join(tmpdir(), 'clone-qa-happy')
try {
  rmSync(workDir, { recursive: true, force: true })
} catch {
  /* stale dir from an aborted previous run; continue */
}
const spyLog = join(workDir, 'spy.log')
mkdirSync(workDir, { recursive: true })

function fail(message) {
  console.error(`QA_HAPPY_FAIL ${message}`)
  process.exitCode = 1
  app.exit(1)
  throw new Error(message)
}

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') fail('platform/arch not win32/x64')
  if (!existsSync(addonPath)) fail(`addon missing: ${addonPath}`)

  // Bundle the real worker + host + loader to CJS (esbuild), like the loader QA.
  const workerBundle = join(buildDir, 'clone-worker-qa.cjs')
  const hostBundle = join(buildDir, 'clone-host-qa.cjs')
  buildSync({
    entryPoints: [srcWorker],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: workerBundle,
    logLevel: 'silent'
  })
  buildSync({
    entryPoints: [srcHost],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    outfile: hostBundle,
    logLevel: 'silent'
  })
  buildSync({
    entryPoints: [loaderTs],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    outfile: join(buildDir, 'clone-qa-loader.cjs'),
    logLevel: 'silent'
  })

  const { loadHubFetchJob, getCloneSupport } = require(join(buildDir, 'clone-qa-loader.cjs'))
  const { CloneHost } = require(hostBundle)

  const bridge = loadHubFetchJob({
    overridePath: addonPath,
    isPackaged: false,
    appPath: root,
    platform: 'win32',
    arch: 'x64',
    modulesVersion: process.versions.modules,
    checkExists: existsSync
  })
  if (bridge.status !== 'ready') fail(`bridge not ready: ${JSON.stringify(bridge)}`)
  const support = getCloneSupport(bridge)
  if (support.enabled !== true) fail(`clone support not enabled: ${JSON.stringify(support)}`)

  const host = new CloneHost({
    bridge,
    workerModulePath: workerBundle,
    fork: (modulePath, args, opts) => utilityProcess.fork(modulePath, args, opts),
    graceIntervalMs: 2000,
    waitTimeoutMs: 30000,
    emptyTimeoutMs: 30000,
    now: () => Date.now()
  })

  const envelope = {
    version: 1,
    assignmentId: 'qa-happy-clone',
    git: process.execPath,
    argv: [gitSpy, gitLeaf],
    cwd: workDir,
    env: { ELECTRON_RUN_AS_NODE: '1', CLONE_SPY_LOG: spyLog }
  }

  const events = []
  const p = host.startClone({
    assignmentId: envelope.assignmentId,
    envelope,
    onEvent: (event) => events.push(event)
  })

  // Wait for progress to arrive AND the grandchild to have booted (its PID
  // must be in the spy log) before cancelling — the tree must really exist.
  const treeDeadline = Date.now() + 30000
  let spyText = ''
  while (Date.now() < treeDeadline) {
    await new Promise((r) => setTimeout(r, 50))
    spyText = existsSync(spyLog) ? readFileSync(spyLog, 'utf8') : ''
    const hasProgress = events.some((e) => e.type === 'progress')
    const hasLeaf = /LEAF_PID=\d+/.test(spyText)
    if (hasProgress && hasLeaf) break
  }

  const record = await host.cancelClone(envelope.assignmentId)

  // The startClone promise must also resolve (clone is settled by the cancel).
  const startRecord = await Promise.race([p, Promise.resolve(null)])

  // Assertions
  const expectedSteps = ['spawn', 'ready', 'assign', 'contains', 'arm', 'start']
  const stepsOk = JSON.stringify(record.steps) === JSON.stringify(expectedSteps)
  if (!stepsOk) fail(`steps mismatch: ${JSON.stringify(record.steps)}`)

  const progressOk = events.some((e) => e.type === 'progress')
  if (!progressOk) fail('no progress event received from worker')

  if (record.outcome !== 'cancelled') fail(`outcome=${record.outcome}`)
  if (record.zeroProven !== true) fail(`zeroProven=${record.zeroProven} error=${record.error}`)
  if (record.degradedTaskkill) fail('degraded taskkill should not be needed in the happy path')
  if (startRecord && startRecord.outcome !== 'cancelled') {
    fail(`startClone resolved to ${startRecord.outcome} after cancel`)
  }

  // The git spy DID run (so the tree was really spawned)...
  const spyTextFinal = readFileSync(spyLog, 'utf8')
  if (!spyTextFinal.includes('SPAWN_PID=')) fail('git-spy never ran (SPAWN_PID missing)')
  const spawnPid = Number.parseInt((/SPAWN_PID=(\d+)/.exec(spyTextFinal) || [])[1] || '0', 10)
  if (!(spawnPid > 0)) fail('no git-spy PID recorded')
  const leafPid = Number.parseInt((/LEAF_PID=(\d+)/.exec(spyTextFinal) || [])[1] || '0', 10)
  if (!(leafPid > 0)) fail('grandchild (LEAF) never spawned')

  // ...but after cancel the Job must be empty AND both descendants dead.
  const isDead = (pid) => {
    try {
      process.kill(pid, 0)
      return false
    } catch (err) {
      return err && err.code === 'ESRCH'
    }
  }
  if (!isDead(spawnPid)) fail(`git-spy still alive after cancel: ${spawnPid}`)
  if (!isDead(leafPid)) fail(`grandchild still alive after cancel: ${leafPid}`)

  console.log(
    'QA_HAPPY_PASS ' +
      JSON.stringify(
        {
          steps: record.steps,
          outcome: record.outcome,
          zeroProven: record.zeroProven,
          degradedTaskkill: record.degradedTaskkill,
          progressEvents: events.filter((e) => e.type === 'progress').length,
          logEvents: events.filter((e) => e.type === 'log').length,
          gitSpawnPid: spawnPid,
          grandchildPid: leafPid,
          bothDeadAfterCancel: isDead(spawnPid) && isDead(leafPid),
          hostActiveAfterSettle: host.activeIds().length,
          bridge: {
            status: bridge.status,
            addonPath: bridge.addonPath,
            runtimeInfo: bridge.runtimeInfo
          },
          cloneSupport: support,
          spyLog: spyText.trim().split('\n'),
          headless: 'no BrowserWindow created; utilityProcess.fork only'
        },
        null,
        2
      )
  )

  // Cleanup temp dir.
  try {
    rmSync(workDir, { recursive: true, force: true })
  } catch {
    /* best-effort cleanup */
  }

  // Bounded flush so any native AsyncWorker (waitForEmpty threadsafe callback)
  // drains before app.exit tears down the Napi environment. Without this, a
  // queued OnOK can fire during teardown and FATAL.
  await new Promise((r) => setTimeout(r, 300))
  app.exit(0)
}

app
  .whenReady()
  .then(main)
  .catch((err) => fail(`unexpected rejection: ${err && err.stack}`))
