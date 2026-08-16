// apps/desktop/native/windows/test/electron-clone-qa-failure.cjs
//
// Todo 27 QA FAILURE PATH under the REAL Electron main runtime. Proves Git is
// NEVER spawned when the gate refuses:
//
//   Case A — fake bridge rejects assignment: CloneHost.startClone with a bridge
//            whose createJob returns a handle whose assignProcess fails. The
//            typed failure is persisted in the record, steps stop at 'assign',
//            no envelope is sent, and the git-spy fixture never runs (spy log
//            has zero SPAWN lines).
//
//   Case B — another worker sends forged early start: a SEPARATE idle worker is
//            forked directly and given a `start` command with NO arm. The worker
//            must refuse (typed 'missing-envelope'/'early-start'), never spawn
//            Git, and the spy log must remain empty.
//
//   Case C — tampered envelope: an idle worker receives `arm` whose envelopeHash
//            does not match the envelope; it must refuse 'tampered-envelope'
//            without spawning.
//
// Prints QA_FAILURE_PASS JSON; exits non-zero on any failure.
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
const addonPath = join(here, '..', 'build', 'Release', 'hubfetch_job.node')
const gitSpy = join(here, 'fixtures', 'clone-git-spy.cjs')
const gitLeaf = join(here, 'fixtures', 'clone-git-leaf.cjs')
const buildDir = join(here, '..', 'build')

const workDir = join(tmpdir(), 'clone-qa-failure')
try {
  rmSync(workDir, { recursive: true, force: true })
} catch {
  /* stale dir from an aborted previous run; continue */
}
const spyLog = join(workDir, 'spy.log')
mkdirSync(workDir, { recursive: true })

function fail(message) {
  console.error(`QA_FAILURE_FAIL ${message}`)
  process.exitCode = 1
  app.exit(1)
  throw new Error(message)
}

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') fail('platform/arch not win32/x64')
  if (!existsSync(addonPath)) fail(`addon missing: ${addonPath}`)

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

  const { CloneHost } = require(hostBundle)

  const baseEnvelope = {
    version: 1,
    assignmentId: 'qa-failure-clone',
    git: process.execPath,
    argv: [gitSpy, gitLeaf],
    cwd: workDir,
    env: { ELECTRON_RUN_AS_NODE: '1', CLONE_SPY_LOG: spyLog }
  }

  // ---- Case A: fake bridge rejects assignment ------------------------------
  const rejectingJob = {
    assignProcess: () => ({
      ok: false,
      code: 'HUBFETCH_JOB_ASSIGN_FAILED',
      errorCode: 'access-denied',
      message: 'qa: assign refused'
    }),
    containsProcess: () => ({ ok: true, contains: false }),
    activeProcessIds: () => ({ ok: true, pids: [] }),
    terminate: () => ({ ok: true }),
    waitForEmpty: async () => ({ ok: true }),
    close: () => ({ ok: true })
  }
  const rejectingBridge = {
    status: 'ready',
    addonPath,
    runtimeInfo: {
      addonName: 'hubfetch_job',
      addonVersion: '0.2.0',
      nodeAbi: Number(process.versions.modules),
      arch: 'x64',
      napiVersion: 10
    },
    probeJob: () => ({ ok: true }),
    createJob: () => ({ ok: true, handle: rejectingJob })
  }
  const hostA = new CloneHost({
    bridge: rejectingBridge,
    workerModulePath: workerBundle,
    fork: (modulePath, args, opts) => utilityProcess.fork(modulePath, args, opts),
    graceIntervalMs: 500,
    waitTimeoutMs: 5000,
    emptyTimeoutMs: 5000,
    now: () => Date.now()
  })
  const recordA = await hostA.startClone({
    assignmentId: baseEnvelope.assignmentId,
    envelope: baseEnvelope
  })
  if (recordA.outcome !== 'failed') fail(`case A outcome=${recordA.outcome}`)
  if (!recordA.error || !recordA.error.includes('HUBFETCH_JOB_ASSIGN_FAILED')) {
    fail(`case A error not persisted: ${JSON.stringify(recordA)}`)
  }
  if (recordA.steps.join('->') !== 'spawn->ready->assign') {
    fail(`case A steps: ${JSON.stringify(recordA.steps)}`)
  }
  if (recordA.refusedCode !== null) fail('case A should have no refusal code')
  if (hostA.activeIds().length !== 0) fail('case A left an active clone')

  // ---- Case B: forged early start on a fresh idle worker -------------------
  const forgedEvents = []
  const forgedChild = utilityProcess.fork(workerBundle)
  forgedChild.on('message', (message) => forgedEvents.push(message))
  forgedChild.on('error', () => {})
  // Wait for ready, then send start WITHOUT any arm.
  const forgedReadyDeadline = Date.now() + 10000
  while (!forgedEvents.some((e) => e && e.type === 'ready') && Date.now() < forgedReadyDeadline) {
    await new Promise((r) => setTimeout(r, 20))
  }
  if (!forgedEvents.some((e) => e && e.type === 'ready')) fail('case B worker never became ready')
  forgedChild.postMessage({ type: 'start', assignmentId: baseEnvelope.assignmentId })
  const forgedRefusalDeadline = Date.now() + 10000
  while (
    !forgedEvents.some((e) => e && e.type === 'refused') &&
    Date.now() < forgedRefusalDeadline
  ) {
    await new Promise((r) => setTimeout(r, 20))
  }
  const refusalB = forgedEvents.find((e) => e && e.type === 'refused')
  if (!refusalB) fail(`case B worker never refused: ${JSON.stringify(forgedEvents)}`)
  if (!['missing-envelope', 'early-start'].includes(refusalB.code)) {
    fail(`case B refusal code unexpected: ${JSON.stringify(refusalB)}`)
  }
  forgedChild.kill()

  // ---- Case C: tampered envelope (wrong hash) ------------------------------
  const tamperedEvents = []
  const tamperedChild = utilityProcess.fork(workerBundle)
  tamperedChild.on('message', (message) => tamperedEvents.push(message))
  tamperedChild.on('error', () => {})
  const tamperedReadyDeadline = Date.now() + 10000
  while (
    !tamperedEvents.some((e) => e && e.type === 'ready') &&
    Date.now() < tamperedReadyDeadline
  ) {
    await new Promise((r) => setTimeout(r, 20))
  }
  if (!tamperedEvents.some((e) => e && e.type === 'ready')) fail('case C worker never became ready')
  tamperedChild.postMessage({
    type: 'arm',
    assignmentId: baseEnvelope.assignmentId,
    envelope: baseEnvelope,
    envelopeHash: 'deadbeef'.repeat(8)
  })
  const tamperedRefusalDeadline = Date.now() + 10000
  while (
    !tamperedEvents.some((e) => e && e.type === 'refused') &&
    Date.now() < tamperedRefusalDeadline
  ) {
    await new Promise((r) => setTimeout(r, 20))
  }
  const refusalC = tamperedEvents.find((e) => e && e.type === 'refused')
  if (!refusalC) fail(`case C worker never refused: ${JSON.stringify(tamperedEvents)}`)
  if (refusalC.code !== 'tampered-envelope') {
    fail(`case C refusal code unexpected: ${JSON.stringify(refusalC)}`)
  }
  tamperedChild.kill()

  // ---- Git-spawn spy must be zero across every failure ---------------------
  const spyText = existsSync(spyLog) ? readFileSync(spyLog, 'utf8') : ''
  const spawnCount = (spyText.match(/SPAWN_PID=/g) || []).length
  if (spawnCount !== 0) {
    fail(`git-spy spawned ${spawnCount} times across failure cases: ${JSON.stringify(spyText)}`)
  }

  console.log(
    'QA_FAILURE_PASS ' +
      JSON.stringify(
        {
          cases: {
            A_assign_rejected: {
              outcome: recordA.outcome,
              steps: recordA.steps,
              error: recordA.error,
              typedCode: /HUBFETCH_JOB_ASSIGN_FAILED/.test(recordA.error ?? '')
            },
            B_forged_early_start: {
              refusalCode: refusalB.code,
              message: refusalB.message
            },
            C_tampered_envelope: {
              refusalCode: refusalC.code,
              message: refusalC.message
            }
          },
          gitSpawnSpyCount: spawnCount,
          typedFailurePersisted: recordA.outcome === 'failed' && recordA.error !== null,
          headless: 'no BrowserWindow created; utilityProcess.fork only'
        },
        null,
        2
      )
  )

  try {
    rmSync(workDir, { recursive: true, force: true })
  } catch {
    /* best-effort cleanup */
  }

  // Bounded flush so native AsyncWorker callbacks drain before teardown.
  await new Promise((r) => setTimeout(r, 300))
  app.exit(0)
}

app
  .whenReady()
  .then(main)
  .catch((err) => fail(`unexpected rejection: ${err && err.stack}`))
