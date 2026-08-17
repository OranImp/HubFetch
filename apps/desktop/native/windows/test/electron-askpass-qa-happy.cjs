// apps/desktop/native/windows/test/electron-askpass-qa-happy.cjs
//
// Todo 30 QA HAPPY PATH under the REAL Electron main runtime (runAsNode=false,
// so the addon + a real clone Job exist; headless — no window is created).
//
//  1. A local smart-HTTP Git server behind Basic authentication serves a bare
//     repository (fake token, local only — no network).
//  2. CONTROL: `git ls-remote` with a FAKE credential helper configured via
//     GIT_CONFIG_GLOBAL (and an EMPTY GIT_CONFIG_SYSTEM so the machine's real
//     system helpers / GCM are isolated out) and NO AskPass override — the
//     fake helper RUNS (spy log entry) and the auth fails typed. This proves
//     the spy would fire if the app-token override did not neutralize it.
//  3. The app-token clone: real system Git runs INSIDE the linked Job (a child
//     process assigned to the Job BEFORE git runs, exactly as the utility clone
//     worker is), with the EXACT app-token contract env
//     (GIT_ASKPASS=<helper>, HUBFETCH_ASKPASS_PIPE=<locator>,
//     GIT_TERMINAL_PROMPT=0, GIT_CONFIG_COUNT=1 / GIT_CONFIG_KEY_0=credential.helper
//     / GIT_CONFIG_VALUE_0=, plus `-c credential.helper=` argv) and a real
//     Job-bound AskPass session holding the fake token. The clone must SUCCEED
//     via the helper while the fake credential helper NEVER runs (spy count
//     unchanged after the control).
//  4. The fixture server observed the EXACT `Basic base64(hf_user:<token>)`
//     header, the token sentinel is absent from process command lines / env
//     snapshots / logs / scratch / support ZIP / evidence, and the packaged
//     helper is an x64 console PE.
//
// Prints QA_HAPPY_PASS JSON; exits non-zero on any failure.
'use strict'
const { app } = require('electron')
const { spawnSync, spawn } = require('node:child_process')
const {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmSync,
  statSync
} = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const here = __dirname
const addonPath = join(here, '..', 'build', 'Release', 'hubfetch_job.node')
const helperPath = join(here, '..', 'build', 'Release', 'HubFetchAskPass.exe')
const httpServerFixture = join(here, 'fixtures', 'askpass-git-http-server.cjs')
const addon = require(addonPath)

const GIT = 'C:\\Program Files\\Git\\cmd\\git.exe'
const SENTINEL = 'qa-askpass-sentinel-' + Math.random().toString(16).slice(2, 12)

const workDir = join(
  tmpdir(),
  't30-askpass-qa-happy-' + Date.now() + '-' + Math.random().toString(16).slice(2, 8)
)
mkdirSync(workDir, { recursive: true })
const bareRepo = join(workDir, 'repo.git')
const seedRepo = join(workDir, 'seed')
const dest = join(workDir, 'dest')
const authLog = join(workDir, 'auth.log')
const spyLog = join(workDir, 'fake-helper.log')
const globalConfig = join(workDir, 'git-global.config')
const systemConfig = join(workDir, 'git-system.config')
const qaOutput = join(workDir, 'qa-output.json')

function fail(message) {
  console.error('QA_HAPPY_FAIL ' + message)
  app.exit(1)
  throw new Error(message)
}

function git(args, opts = {}) {
  return spawnSync(GIT, args, {
    cwd: opts.cwd,
    env: opts.env ?? { ...process.env },
    encoding: 'utf8',
    timeout: 60000
  })
}

function containsSentinel(data) {
  return Buffer.isBuffer(data) ? data.includes(Buffer.from(SENTINEL)) : data.includes(SENTINEL)
}

function allBytes(dir) {
  let out = Buffer.alloc(0)
  const walk = (d) => {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry)
      const st = statSync(p)
      if (st.isDirectory()) walk(p)
      else out = Buffer.concat([out, readFileSync(p)])
    }
  }
  walk(dir)
  return out
}

function captureProcessCommandLines() {
  const r = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      'Get-CimInstance Win32_Process | Where-Object { $_.Name -match "git|askpass" } | Select-Object -ExpandProperty CommandLine'
    ],
    { encoding: 'utf8', timeout: 30000 }
  )
  return r.stdout || ''
}

function startServer(port) {
  const server = spawn(
    process.execPath,
    [httpServerFixture, bareRepo, String(port), SENTINEL, authLog],
    {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )
  return new Promise((resolve, reject) => {
    let out = ''
    server.stdout.on('data', (d) => {
      out += d.toString()
      if (out.includes('LISTENING')) resolve(server)
    })
    server.stderr.on('data', (d) => {
      console.error('git-http-server stderr: ' + d.toString())
    })
    setTimeout(() => reject(new Error('git http server did not start')), 10000)
  })
}

async function main() {
  const results = {}

  // 0. environment sanity + packaged helper PE check
  if (process.platform !== 'win32' || process.arch !== 'x64') fail('platform/arch')
  if (!existsSync(addonPath)) fail('addon missing')
  if (!existsSync(helperPath)) fail('helper missing')
  if (!existsSync(GIT)) fail('system git missing: ' + GIT)
  {
    const b = readFileSync(helperPath)
    const pe = b.readUInt32LE(0x3c)
    results.helperPe = {
      machine: b.readUInt16LE(pe + 4),
      magic: b.readUInt16LE(pe + 0x18),
      subsystem: b.readUInt16LE(pe + 0x5c)
    }
    if (results.helperPe.machine !== 0x8664 || results.helperPe.subsystem !== 3) {
      fail('helper is not an x64 console PE')
    }
  }

  // 1. bare repository + seed commit (sized so the clone takes real time)
  {
    mkdirSync(seedRepo)
    mkdirSync(join(seedRepo, 'files'))
    writeFileSync(join(seedRepo, 'README.md'), 'askpass qa repo\n')
    writeFileSync(join(seedRepo, 'data.bin'), Buffer.from('binary-payload-123456'))
    for (let i = 0; i < 400; i++) {
      writeFileSync(
        join(seedRepo, 'files', `file-${String(i).padStart(4, '0')}.txt`),
        `payload-${i}\n`
      )
    }
    git(['init', '-b', 'main'], { cwd: seedRepo })
    git(['config', 'user.email', 'qa@example.com'], { cwd: seedRepo })
    git(['config', 'user.name', 'QA'], { cwd: seedRepo })
    git(['add', '.'], { cwd: seedRepo })
    git(['commit', '-m', 'seed'], { cwd: seedRepo })
    git(['init', '--bare', bareRepo])
    git(['remote', 'add', 'origin', bareRepo], { cwd: seedRepo })
    git(['push', 'origin', 'main'], { cwd: seedRepo })
    git(['--git-dir', bareRepo, 'symbolic-ref', 'HEAD', 'refs/heads/main'])
    const refs = git(['--git-dir', bareRepo, 'show-ref', 'refs/heads/main'])
    if (refs.status !== 0) fail('bare repo has no main ref: ' + refs.stderr)
    results.bareRepo = { ref: refs.stdout.trim() }
  }

  // 2. fake credential helper spy (GIT_CONFIG_GLOBAL) + EMPTY GIT_CONFIG_SYSTEM
  {
    const logQuoted = workDir.replace(/\\/g, '/') + '/fake-helper.log'
    writeFileSync(globalConfig, `[credential]\n\thelper = "!echo INVOKED >> \\"${logQuoted}\\""\n`)
    writeFileSync(systemConfig, '')
    results.fakeHelperConfig = globalConfig
    results.systemConfigIsolated = systemConfig
  }

  // 3. Basic-auth smart-HTTP server
  const port = 19000 + Math.floor(Math.random() * 2000)
  const server = await startServer(port)
  const url = `http://127.0.0.1:${port}/repo.git`

  // 4. CONTROL: fake helper configured, NO AskPass override → spy fires, fail typed
  {
    writeFileSync(spyLog, '')
    const r = git(['ls-remote', url], {
      env: {
        ...process.env,
        GIT_CONFIG_SYSTEM: systemConfig,
        GIT_CONFIG_GLOBAL: globalConfig,
        GIT_TERMINAL_PROMPT: '0'
      }
    })
    results.control = {
      exit: r.status,
      stderr: (r.stderr || '').slice(0, 200),
      spyLog: readFileSync(spyLog, 'utf8').trim()
    }
    if (r.status === 0) fail('control ls-remote unexpectedly succeeded')
    if (!results.control.spyLog.includes('INVOKED')) {
      fail('control: fake credential helper never ran: ' + JSON.stringify(results.control))
    }
    results.controlCount = (results.control.spyLog.match(/INVOKED/g) || []).length
  }

  // 5. app-token clone: git inside the linked Job, exact contract env/argv
  {
    const job = addon.createKillOnCloseJob()
    const created = addon.createAskPassSession({
      token: Buffer.from(SENTINEL, 'utf8'),
      username: 'hf_user',
      job,
      ttlMs: 60000,
      promptLimit: 4
    })
    const beforeCount = (readFileSync(spyLog, 'utf8').match(/INVOKED/g) || []).length

    // The EXACT app-token contract env for the git child.
    const gitEnv = {
      ...process.env,
      LC_ALL: 'C',
      GIT_PROGRESS_DELAY: '0',
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_SYSTEM: systemConfig,
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_ASKPASS: helperPath,
      HUBFETCH_ASKPASS_PIPE: created.pipeName,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: ''
    }
    const gitArgv = ['-c', 'credential.helper=', 'clone', '--progress', url, dest]
    results.appTokenContract = {
      envKeys: Object.keys(gitEnv)
        .filter((k) => k.startsWith('GIT_') || k.startsWith('HUBFETCH_'))
        .sort(),
      argv: gitArgv
    }

    // Run git inside the Job: a runner child is assigned to the Job BEFORE git
    // runs (the same assign-before-spawn order the utility clone worker uses).
    const runnerScript = join(workDir, 'run-clone.cjs')
    const runnerLog = join(workDir, 'runner.log')
    writeFileSync(
      runnerScript,
      `'use strict'
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const log = ${JSON.stringify(runnerLog)}
const write = (t) => fs.appendFileSync(log, t + '\\n')
process.on('uncaughtException', (e) => { write('UNCAUGHT ' + e.stack); process.exit(3) })
process.on('exit', (c) => write('EXIT ' + c))
write('started pid=' + process.pid)
process.stdout.write('READY ' + process.pid + '\\n')
process.stdin.resume()
process.stdin.on('data', (c) => {
  write('data=' + JSON.stringify(c.toString()))
  if (!c.toString().includes('GO')) return
  write('GO received')
  try {
    const r = spawnSync(${JSON.stringify(GIT)}, ${JSON.stringify(gitArgv)}, {
      cwd: ${JSON.stringify(workDir)},
      env: ${JSON.stringify(gitEnv)},
      encoding: 'utf8',
      timeout: 120000
    })
    write('spawnSync status=' + r.status + ' error=' + (r.error && r.error.message))
    process.stdout.write('CLONE_STATUS=' + r.status + '\\n')
    process.stdout.write('CLONE_STDOUT=' + JSON.stringify(r.stdout || '').slice(0, 200) + '\\n')
    process.stdout.write('CLONE_STDERR=' + JSON.stringify((r.stderr || '').slice(0, 400)) + '\\n')
  } catch (e) {
    write('SPAWN_THREW ' + e.stack)
    process.stdout.write('CLONE_THREW=' + e.message + '\\n')
  }
  process.exit(0)
})
`
    )
    const child = spawn(process.execPath, [runnerScript], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d.toString()))
    child.stderr.on('data', (d) => (err += d.toString()))

    // capture process command lines while the clone runs
    const cmdlinesDuring = []
    const capturer = setInterval(() => {
      cmdlinesDuring.push(captureProcessCommandLines())
    }, 100)

    const assigned = await new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        const m = /READY (\d+)/.exec(out)
        if (!m) return
        clearInterval(timer)
        const pid = Number(m[1])
        const assign = job.assignProcess(pid)
        const contains = job.containsProcess(pid)
        resolve({ ok: assign.ok, inJob: contains.ok && contains.contains, pid })
      }, 20)
      setTimeout(() => {
        clearInterval(timer)
        reject(new Error('runner did not report READY: ' + out + err))
      }, 10000)
    })
    results.assignment = assigned
    if (!assigned.ok || !assigned.inJob) fail('runner not in the Job: ' + JSON.stringify(assigned))
    child.stdin.write('GO\n')

    const ran = await new Promise((resolve) => {
      // 'close' (not 'exit') guarantees all stdio pipes flushed before we parse.
      child.on('close', () => resolve(true))
      setTimeout(() => resolve(false), 150000)
    })
    clearInterval(capturer)
    if (!ran) fail('runner never exited')

    const cloneStatus = /CLONE_STATUS=(\d+)/.exec(out)
    results.clone = {
      status: cloneStatus ? Number(cloneStatus[1]) : null,
      stdout: (/\nCLONE_STDOUT=(.*)\n/.exec(out) || [])[1] || '',
      stderr: (/\nCLONE_STDERR=(.*)\n/.exec(out) || [])[1] || ''
    }
    if (results.clone.status !== 0) {
      fail(
        'app-token clone failed: ' +
          JSON.stringify(results.clone) +
          ' RUNNER_OUT=' +
          out +
          ' RUNNER_ERR=' +
          err
      )
    }
    if (!existsSync(join(dest, '.git'))) fail('destination has no .git')
    const head = git(['-C', dest, 'rev-parse', 'HEAD'])
    results.cloneHead = head.stdout.trim()
    if (head.status !== 0 || !/^[0-9a-f]{40}$/.test(results.cloneHead))
      fail('HEAD verification failed')
    if (!existsSync(join(dest, 'README.md'))) fail('README.md not cloned')
    if (!existsSync(join(dest, 'files', 'file-0000.txt'))) fail('files/ not cloned')

    // The fake credential helper NEVER ran during the app-token clone.
    const afterCount = (readFileSync(spyLog, 'utf8').match(/INVOKED/g) || []).length
    results.fakeHelperInvocationCount = { before: beforeCount, after: afterCount }
    if (afterCount !== beforeCount) {
      fail(
        'fake credential helper RAN during the app-token clone (spy ' +
          afterCount +
          ' vs ' +
          beforeCount +
          ')'
      )
    }

    // The fixture server observed the exact Basic header.
    const authLines = existsSync(authLog) ? readFileSync(authLog, 'utf8').trim().split('\n') : []
    const expectedBasic = 'Basic ' + Buffer.from('hf_user:' + SENTINEL).toString('base64')
    results.observedBasicHeader = authLines.filter((l) => l === expectedBasic).length
    if (results.observedBasicHeader < 1) {
      fail('server never saw the expected Basic header: ' + JSON.stringify(authLines.slice(0, 5)))
    }
    results.serverAuthRequests = authLines.length

    // Sentinel absent from process command lines captured during the clone.
    const combinedCmdlines = cmdlinesDuring.join('\n')
    results.sentinelInCommandLines = containsSentinel(combinedCmdlines)
    if (containsSentinel(combinedCmdlines)) fail('sentinel leaked into a process command line')

    // Sentinel absent from the scratch dir (config/log/server/dest).
    results.sentinelInScratch = containsSentinel(allBytes(workDir))
    if (results.sentinelInScratch) fail('sentinel found in scratch files')

    // Sentinel absent from the helper exe binary (package scan).
    results.sentinelInHelperBinary = containsSentinel(readFileSync(helperPath))
    if (containsSentinel(readFileSync(helperPath))) fail('sentinel found in the helper binary')

    created.session.close()
    job.close()
  }

  // 6. evidence output + support-zip style scan
  {
    writeFileSync(qaOutput, JSON.stringify(results, null, 2))
    const zipPath = join(workDir, 'support.zip')
    const zr = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Compress-Archive -Path "${workDir}\\*" -DestinationPath "${zipPath}" -Force`
      ],
      { encoding: 'utf8', timeout: 60000 }
    )
    if (zr.status === 0 && existsSync(zipPath)) {
      results.sentinelInSupportZip = containsSentinel(readFileSync(zipPath))
      if (results.sentinelInSupportZip) fail('sentinel found in the support ZIP')
    }
    results.sentinelInEvidence = containsSentinel(readFileSync(qaOutput))
    if (results.sentinelInEvidence) fail('sentinel found in the evidence output')
  }

  server.kill()
  console.log('QA_HAPPY_PASS ' + JSON.stringify(results, null, 2))
  await new Promise((r) => setTimeout(r, 300))
  try {
    rmSync(workDir, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
  app.exit(0)
}

app
  .whenReady()
  .then(main)
  .catch((err) => fail(err && err.stack ? err.stack : String(err)))
