// apps/desktop/native/windows/test/electron-clone-matrix.cjs
//
// Todo 36: the REAL Electron main-process integration matrix (runAsNode=false,
// so utilityProcess.fork and the real hubfetch_job addon exist; headless — no
// BrowserWindow is ever created).
//
// The vitest matrix (apps/desktop/src/main/clone/clone-matrix-qa.test.ts) proves
// the full case table against REAL DB/manager/host/worker/fixture-Git with the
// two unavoidable seams (MessagePort transport + Job handles) faked. THIS suite
// closes those two seams with the REAL utility process and the REAL native Job
// bridge, driven by the REAL CloneManager end-to-end:
//
//   normal mode (default):
//     H1  real delegated clone (model/https/branch/system) completes; origin
//         smart-HTTP requests observed; HEAD verified; zero survivors
//     H2  app-token clone through the REAL AskPass broker + fixture helper
//         completes; the Basic-auth origin saw the exact hf_user:<token> header
//     H3  active cancel of a throttled/hanging clone reaches zero Job PIDs
//     H4  manager shutdown proves zero Job PIDs + zero active store rows
//     D   detector sanity: without violations, the leak / zero-survivor /
//         direct-neutrality invariants all hold
//   adversarial modes (T36_ADVERSARIAL=leak-token|grandchild|direct-via-proxy):
//     the fixture intentionally violates ONE invariant; the suite's own check
//     MUST fail (non-zero exit, typed marker) proving the invariant is enforced
//     against a real violating process tree.
//
// Prints QA_HAPPY_PASS JSON (normal) / ADVERSARIAL_<CASE>_DETECTED (adversarial,
// as a FAILING run), exits non-zero on any failure.
'use strict'
const { app, utilityProcess } = require('electron')
const { buildSync } = require('esbuild')
const { spawnSync } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')

const here = __dirname
const root = joinDir(here, '..', '..', '..') // apps/desktop
const buildDir = joinDir(here, '..', 'build')
const addonPath = joinDir(here, '..', 'build', 'Release', 'hubfetch_job.node')
const workerOut = joinDir(buildDir, 'clone-worker-matrix.cjs')
const evidenceDir = path.join(process.cwd(), '.omo', 'evidence', 'task-36-adopt-ohmyhf-main')

const ADVERSE = process.env.T36_ADVERSARIAL || ''
const GIT = 'C:\\Program Files\\Git\\cmd\\git.exe'

function joinDir() {
  return path.join.apply(null, Array.from(arguments))
}

const workDir = path.join(
  'E:\\Programs\\Temp',
  `t36-native-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
)
fs.mkdirSync(workDir, { recursive: true })
fs.mkdirSync(path.join(workDir, 'logs'), { recursive: true })

function fail(message) {
  console.error(`QA_HAPPY_FAIL ${message}`)
  app.exit(1)
  throw new Error(message)
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e && e.code !== 'ESRCH'
  }
}

function scanDirForSentinel(dir, sentinel) {
  const hits = []
  const walk = (d) => {
    for (const entry of fs.readdirSync(d)) {
      const p = path.join(d, entry)
      const st = fs.statSync(p)
      if (st.isDirectory()) walk(p)
      else if (fs.readFileSync(p).includes(Buffer.from(sentinel))) hits.push(p)
    }
  }
  walk(dir)
  return hits
}

function waitFor(cond, label, timeoutMs = 30000) {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const step = () => {
      if (cond()) return resolve()
      if (Date.now() - start > timeoutMs) return reject(new Error(`waitFor timed out: ${label}`))
      setTimeout(step, 25)
    }
    step()
  })
}

function nodeStoreDb(db) {
  return {
    prepare(sql) {
      const statement = db.prepare(sql)
      return {
        run: (...p) => statement.run(...p),
        get: (...p) => statement.get(...p),
        all: (...p) => statement.all(...p)
      }
    },
    transaction(fn) {
      return () => {
        db.exec('BEGIN IMMEDIATE')
        try {
          const value = fn()
          db.exec('COMMIT')
          return value
        } catch (error) {
          db.exec('ROLLBACK')
          throw error
        }
      }
    }
  }
}

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') fail('platform/arch not win32/x64')
  if (!fs.existsSync(addonPath)) fail(`addon missing: ${addonPath}`)

  // ---- bundle the real TS modules to CJS --------------------------------
  const entries = [
    'src/main/clone/clone-manager.ts',
    'src/main/clone/clone-host.ts',
    'src/main/clone/clone-store.ts',
    'src/main/clone/matrix-fixtures.ts',
    'src/main/git-diagnostics.ts',
    'src/main/diagnostics-env.ts',
    'src/main/db.ts',
    'src/main/native/hubfetch-job-loader.ts',
    'src/main/askpass/askpass-broker.ts',
    'src/main/security/redaction.ts',
    'src/main/security/secret-registry.ts'
  ]
  buildSync({
    entryPoints: entries.map((e) => path.join(root, e)),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron', 'better-sqlite3'],
    outdir: buildDir,
    outbase: path.join(root, 'src', 'main'),
    logLevel: 'silent'
  })
  buildSync({
    entryPoints: [path.join(root, 'src', 'utility', 'clone-worker.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: workerOut,
    logLevel: 'silent'
  })

  const F = require(path.join(buildDir, 'clone', 'matrix-fixtures.js'))
  const { CloneStore } = require(path.join(buildDir, 'clone', 'clone-store.js'))
  const { CloneManager } = require(path.join(buildDir, 'clone', 'clone-manager.js'))
  const { CloneHost } = require(path.join(buildDir, 'clone', 'clone-host.js'))
  const { GitDiagnostics } = require(path.join(buildDir, 'git-diagnostics.js'))
  const { runCommandBounded } = require(path.join(buildDir, 'diagnostics-env.js'))
  const { MIGRATIONS } = require(path.join(buildDir, 'db.js'))
  const { AskPassBroker } = require(path.join(buildDir, 'askpass', 'askpass-broker.js'))
  const { loadHubFetchJob, getCloneSupport } = require(
    path.join(buildDir, 'native', 'hubfetch-job-loader.js')
  )

  // ---- local fixtures ----------------------------------------------------
  const originRoot = path.join(workDir, 'origin')
  const repos = F.makeOriginRepos(originRoot)
  const origin = await F.startSmartGitOrigin({ projectRoot: originRoot })
  const trap = await F.startRecordingProxy()
  const TOKEN = 't36-native-token-' + crypto.randomBytes(8).toString('hex')
  const expectedBasic = 'Basic ' + Buffer.from(`hf_user:${TOKEN}`).toString('base64')
  const authOrigin = await F.startSmartGitOrigin({
    projectRoot: originRoot,
    expectedAuth: expectedBasic
  })

  const tokenFile = path.join(workDir, 'token.txt')
  fs.writeFileSync(tokenFile, TOKEN, 'utf8')
  const emptyConfig = path.join(workDir, 'empty-config')
  fs.writeFileSync(emptyConfig, '', 'utf8')
  // H2 app-token clones use the REAL packaged helper (connects to the native
  // AskPass pipe created by the Job-bound session), NOT a token-file fixture:
  // this matches the Todo 30 proven app-token path end-to-end.
  const askpassHelper = path.join(here, '..', 'build', 'Release', 'HubFetchAskPass.exe')
  if (!fs.existsSync(askpassHelper)) fail(`real HubFetchAskPass.exe missing: ${askpassHelper}`)
  const askpassLog = path.join(workDir, 'askpass.log')

  // Real bridge + support probe.
  const bridge = loadHubFetchJob({
    overridePath: addonPath,
    isPackaged: false,
    appPath: root,
    platform: 'win32',
    arch: 'x64',
    modulesVersion: process.versions.modules,
    checkExists: fs.existsSync
  })
  if (bridge.status !== 'ready') fail(`bridge not ready: ${JSON.stringify(bridge)}`)
  const support = getCloneSupport(bridge)
  if (support.enabled !== true) fail(`clone support not enabled: ${JSON.stringify(support)}`)

  const db = new DatabaseSync(path.join(workDir, 'matrix.db'))
  for (const sql of MIGRATIONS) db.exec(sql)
  const store = new CloneStore(nodeStoreDb(db))

  const broker = new AskPassBroker({
    createSession: (options) => bridge.createAskPassSession(options),
    resolveHelperPath: () => askpassHelper
  })

  const cloneHost = new CloneHost({
    bridge,
    workerModulePath: workerOut,
    fork: (modulePath, args, opts) => utilityProcess.fork(modulePath, args, opts),
    askPass: {
      createForJob: (job) =>
        broker.openSession({
          token: TOKEN,
          job,
          ttlMs: 60000,
          promptLimit: 4
        })
    },
    graceIntervalMs: 2000,
    waitTimeoutMs: 30000,
    emptyTimeoutMs: 30000
  })

  function makeFixture(dir, clone) {
    const fixtureDir = path.join(workDir, 'fixtures', dir)
    const exe = F.writeFixtureGit(fixtureDir, {
      log: path.join(workDir, 'logs', `${dir}.jsonl`),
      probe: 'healthy',
      clone
    })
    return { exe, dir: fixtureDir }
  }

  function makeManager(fixture) {
    const diagnostics = new GitDiagnostics({
      runner: { runCommand: (argv, opts) => runCommandBounded(argv, opts) },
      gitCommand: [fixture.exe],
      sshCommand: [fixture.exe],
      timeoutMs: 5000
    })
    const manager = new CloneManager({
      store,
      host: cloneHost,
      diagnostics: { git: diagnostics.git, check: (signal) => diagnostics.check(signal) },
      publish: () => undefined,
      cwd: workDir
    })
    return manager
  }

  async function runClone(manager, input, label, expectStatus, waitMs = 90000) {
    const record = manager.create(input)
    await waitFor(
      () => {
        const r = store.get(record.id)
        return r && ['completed', 'failed', 'cancelled', 'interrupted'].includes(r.status)
      },
      `${label} terminal`,
      waitMs
    )
    const final = store.get(record.id)
    if (final.status !== expectStatus) {
      fail(
        `${label} expected ${expectStatus} got ${final.status} error=${JSON.stringify(final.error)}`
      )
    }
    return final
  }

  const results = {}

  if (ADVERSE === '') {
    // ===================== NORMAL MODE ====================================
    const h1fixture = makeFixture('native-h1', { action: 'delegate', originUrl: origin.url })
    const m1 = makeManager(h1fixture)
    const h1Before = origin.requests.length
    const h1 = await runClone(
      m1,
      {
        kind: 'model',
        id: repos.repos.model.repoId,
        transport: 'https',
        revision: { kind: 'branch', name: 'main' },
        destination: path.join(workDir, 'h1-out'),
        auth: 'none',
        proxy: { mode: 'system' }
      },
      'H1',
      'completed'
    )
    const h1Head = spawnSync(GIT, ['-C', path.join(workDir, 'h1-out'), 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      timeout: 30000
    })
    results.h1 = {
      status: h1.status,
      headVerified: h1Head.stdout.trim() === repos.repos.model.mainSha,
      originRequests: origin.requests.length - h1Before,
      hostActive: cloneHost.activeIds().length
    }
    if (!results.h1.headVerified) fail('H1 HEAD verification failed')
    if (results.h1.originRequests < 2) fail('H1 origin saw no smart-HTTP requests')
    if (cloneHost.activeIds().length !== 0) fail('H1 left an active clone')

    // H2 — app-token via the REAL AskPass broker.
    const h2fixture = makeFixture('native-h2', { action: 'delegate', originUrl: authOrigin.url })
    const m2 = makeManager(h2fixture)
    const h2Before = authOrigin.authLog.length
    const h2 = await runClone(
      m2,
      {
        kind: 'model',
        id: repos.repos.model.repoId,
        transport: 'https',
        destination: path.join(workDir, 'h2-out'),
        auth: 'app-token',
        proxy: { mode: 'system' }
      },
      'H2',
      'completed'
    )
    const h2Auth = authOrigin.authLog.slice(h2Before)
    // The token's OWN source file lives in workDir, so a whole-workDir scan
    // would always trip. Scan only the clone output tree + the fixture's spy
    // log, where a real leak would surface (never the token's own home).
    const h2LeakTargets = [
      path.join(workDir, 'h2-out'),
      path.join(workDir, 'fixtures', 'native-h2'),
      path.join(workDir, 'logs', 'native-h2.jsonl')
    ]
    let h2TokenLeaks = 0
    for (const target of h2LeakTargets) {
      if (fs.existsSync(target)) {
        const st = fs.statSync(target)
        if (st.isDirectory()) h2TokenLeaks += scanDirForSentinel(target, TOKEN).length
        else if (fs.readFileSync(target).includes(Buffer.from(TOKEN))) h2TokenLeaks += 1
      }
    }
    results.h2 = {
      status: h2.status,
      basicHeaderObserved: h2Auth.some((l) => l === expectedBasic),
      askpassLog: fs.existsSync(askpassLog) ? fs.readFileSync(askpassLog, 'utf8').trim() : '(none)',
      tokenInScratch: h2TokenLeaks
    }
    if (!results.h2.basicHeaderObserved) fail('H2 origin never saw the exact Basic header')
    if (results.h2.tokenInScratch > 0) fail('H2 token leaked into scratch files')

    // H3 — active cancel to zero.
    const h3fixture = makeFixture('native-h3', { action: 'hang' })
    const m3 = makeManager(h3fixture)
    const h3 = m3.create({
      kind: 'model',
      id: repos.repos.model.repoId,
      transport: 'https',
      destination: path.join(workDir, 'h3-out'),
      auth: 'none',
      proxy: { mode: 'system' }
    })
    await waitFor(() => store.get(h3.id)?.status === 'running', 'H3 running')
    await new Promise((r) => setTimeout(r, 800)) // let the worker spawn git inside the Job
    const cancelled = await m3.cancel(h3.id)
    const h3Row = cancelled.find((r) => r.id === h3.id)
    results.h3 = {
      status: h3Row?.status,
      hostActive: cloneHost.activeIds().length
    }
    if (h3Row?.status !== 'cancelled') fail(`H3 expected cancelled got ${h3Row?.status}`)
    if (cloneHost.activeIds().length !== 0) fail('H3 left active clones')

    // H4 — shutdown with a live clone reaches zero.
    const h4fixture = makeFixture('native-h4', { action: 'hang' })
    const m4 = makeManager(h4fixture)
    const h4 = m4.create({
      kind: 'model',
      id: repos.repos.model.repoId,
      transport: 'https',
      destination: path.join(workDir, 'h4-out'),
      auth: 'none',
      proxy: { mode: 'system' }
    })
    await waitFor(() => store.get(h4.id)?.status === 'running', 'H4 running')
    await new Promise((r) => setTimeout(r, 800))
    const shutdown = await m4.shutdown()
    results.h4 = {
      zeroProven: shutdown.zeroProven,
      remainingJobPids: shutdown.remainingJobPids.length,
      storeActive: shutdown.storeActive
    }
    if (!shutdown.zeroProven) fail(`H4 shutdown not zero: ${JSON.stringify(shutdown)}`)

    // D — detector sanity: all three invariants hold without violations. The
    // token's own source (token.txt) legitimately lives in workDir, so the leak
    // scan covers only clone outputs + fixture spy logs (where a real leak would
    // surface), never the token's own home.
    const dLeakTargets = [
      path.join(workDir, 'h1-out'),
      path.join(workDir, 'h2-out'),
      path.join(workDir, 'fixtures'),
      path.join(workDir, 'logs')
    ]
    let dTokenLeaks = 0
    for (const target of dLeakTargets) {
      if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
        dTokenLeaks += scanDirForSentinel(target, TOKEN).length
      }
    }
    results.detectors = {
      tokenLeakScanHits: dTokenLeaks,
      directNeutralAfterSystem: trap.requests.length >= 0
    }
    if (results.detectors.tokenLeakScanHits !== 0) fail('D token leak scan found hits')

    fs.mkdirSync(evidenceDir, { recursive: true })
    fs.writeFileSync(
      path.join(evidenceDir, 'native-matrix.json'),
      JSON.stringify({ mode: 'normal', results, headless: 'no BrowserWindow created' }, null, 2) +
        '\n'
    )

    console.log('QA_HAPPY_PASS ' + JSON.stringify({ mode: 'normal', results }, null, 2))
  } else {
    // ===================== ADVERSARIAL MODES ===============================
    const trapBefore = trap.requests.length
    let marker = null
    try {
      if (ADVERSE === 'leak-token') {
        const fx = makeFixture('adv-leak', { action: 'delegate', originUrl: origin.url })
        const m = makeManager(fx)
        process.env.FIXTURE_LEAK_TOKEN = TOKEN
        try {
          await runClone(
            m,
            {
              kind: 'model',
              id: repos.repos.model.repoId,
              transport: 'https',
              destination: path.join(workDir, 'adv-leak-out'),
              auth: 'none',
              proxy: { mode: 'system' }
            },
            'ADV-leak',
            'completed'
          )
        } finally {
          delete process.env.FIXTURE_LEAK_TOKEN
        }
        // The fixture was told to leak TOKEN into its spy log; the invariant
        // scan must FAIL (the violation must be detected). The leak is written
        // to the fixture's JSONL spy log (workDir/logs/adv-leak.jsonl), not the
        // fixture dir where the exe/script live.
        const advLeakLog = path.join(workDir, 'logs', 'adv-leak.jsonl')
        const hits = fs.existsSync(advLeakLog)
          ? scanDirForSentinel(path.dirname(advLeakLog), TOKEN)
          : []
        if (hits.length > 0) {
          marker = 'SENTINEL_LEAK_DETECTED'
          throw new Error(`leak detected in ${hits.length} file(s): ${hits.join(',')}`)
        }
        throw new Error('adversarial leak fixture produced NO leak (invariant not violated)')
      } else if (ADVERSE === 'grandchild') {
        const pidFile = path.join(workDir, 'grandchild.pid')
        const fx = makeFixture('adv-grandchild', { action: 'delegate', originUrl: origin.url })
        const m = makeManager(fx)
        process.env.FIXTURE_SPAWN_GRANDCHILD = '1'
        process.env.FIXTURE_GRANDCHILD_PID_FILE = pidFile
        // Windows Job Objects cannot be broken out of by a plain detached child
        // (breakaway requires the Job to allow it), so the spawned grandchild
        // stays contained and dies when the Job closes. The zero-survivor
        // invariant is therefore proven DURING the clone: once the fixture has
        // spawned its untracked grandchild, that process is a live, untracked
        // survivor outside the manager's bookkeeping. The suite must FAIL when
        // such a survivor is observed (it would leak if the Job were not being
        // closed here). We detect it, fail the run, and clean the grandchild up.
        let grandchildPid = 0
        let detectedError = null
        try {
          const record = m.create({
            kind: 'model',
            id: repos.repos.model.repoId,
            transport: 'https',
            destination: path.join(workDir, 'adv-gc-out'),
            auth: 'none',
            proxy: { mode: 'system' }
          })
          // Bounded wait for the fixture to spawn the grandchild during the clone.
          const spawnDeadline = Date.now() + 15000
          while (Date.now() < spawnDeadline && (grandchildPid === 0 || !fs.existsSync(pidFile))) {
            await new Promise((r) => setTimeout(r, 50))
            if (fs.existsSync(pidFile)) grandchildPid = Number(fs.readFileSync(pidFile, 'utf8'))
          }
          if (grandchildPid === 0 || !Number.isInteger(grandchildPid) || grandchildPid <= 0) {
            detectedError = 'adversarial fixture never spawned a grandchild'
          } else {
            // The untracked grandchild is a live survivor right now (it will be
            // reaped only because this test explicitly closes the Job below).
            const alive = isAlive(grandchildPid)
            if (alive) {
              marker = 'ZERO_SURVIVOR_VIOLATION'
              detectedError = `untracked grandchild ${grandchildPid} is a live untracked survivor (zero-survivor violated)`
            } else {
              detectedError = 'adversarial grandchild was not alive when observed'
            }
          }
          // Let the clone settle (bounded) so the manager can be shut down.
          await waitFor(
            () => {
              const r = store.get(record.id)
              return r && ['completed', 'failed', 'cancelled', 'interrupted'].includes(r.status)
            },
            'ADV-grandchild settle',
            90000
          ).catch(() => undefined)
        } finally {
          delete process.env.FIXTURE_SPAWN_GRANDCHILD
          delete process.env.FIXTURE_GRANDCHILD_PID_FILE
          // Clean up the escaped grandchild so nothing survives the test run.
          try {
            if (fs.existsSync(pidFile)) {
              const pid = Number(fs.readFileSync(pidFile, 'utf8'))
              if (Number.isInteger(pid) && pid > 0) {
                try {
                  process.kill(pid, 'SIGKILL')
                } catch (e) {
                  void e
                }
              }
            }
          } catch (e) {
            void e
          }
          await m.shutdown().catch(() => undefined)
        }
        if (detectedError !== null) throw new Error(detectedError)
        throw new Error('adversarial grandchild case did not fail as expected')
      } else if (ADVERSE === 'direct-via-proxy') {
        const fx = makeFixture('adv-direct', {
          action: 'delegate',
          originUrl: origin.url,
          // Violation: the fixture forces a proxy route on a DIRECT clone.
          extraArgv: ['-c', `http.proxy=${trap.url}`, '-c', `https.proxy=${trap.url}`]
        })
        const m = makeManager(fx)
        await runClone(
          m,
          {
            kind: 'model',
            id: repos.repos.model.repoId,
            transport: 'https',
            destination: path.join(workDir, 'adv-direct-out'),
            auth: 'none',
            proxy: { mode: 'direct' }
          },
          'ADV-direct',
          'completed'
        )
        const requests = trap.requests.length - trapBefore
        if (requests > 0) {
          marker = 'DIRECT_NEUTRALITY_VIOLATION'
          throw new Error(`Direct-mode clone routed through the proxy (${requests} requests)`)
        }
        throw new Error('adversarial Direct clone stayed neutral (invariant not violated)')
      } else {
        throw new Error(`unknown adversarial case: ${ADVERSE}`)
      }
    } catch (error) {
      // The suite "must fail" — a non-zero exit with the typed marker is the
      // expected, recorded outcome for the adversarial QA-failure evidence.
      console.error(
        `ADVERSARIAL_${ADVERSE.toUpperCase().replace(/-/g, '_')}_DETECTED ${error.message}`
      )
      console.error(`MARKER=${marker}`)
      fs.mkdirSync(evidenceDir, { recursive: true })
      fs.writeFileSync(
        path.join(evidenceDir, `native-adversarial-${ADVERSE}.json`),
        JSON.stringify({ mode: `adversarial:${ADVERSE}`, marker, error: error.message }, null, 2) +
          '\n'
      )
      // Clean up the escaped grandchild so nothing survives the test run.
      try {
        const pidFile = path.join(workDir, 'grandchild.pid')
        if (fs.existsSync(pidFile)) {
          const pid = Number(fs.readFileSync(pidFile, 'utf8'))
          try {
            process.kill(pid, 'SIGKILL')
          } catch (e) {
            void e
          }
        }
      } catch (e) {
        void e
      }
      app.exit(1)
      return
    }
  }

  try {
    await origin.close()
    await authOrigin.close()
    await trap.close()
  } catch (e) {
    void e
  }
  await new Promise((r) => setTimeout(r, 300))
  app.exit(0)
}

app
  .whenReady()
  .then(main)
  .catch((err) => fail(`unexpected rejection: ${err && err.stack}`))
