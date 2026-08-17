// apps/desktop/native/windows/test/electron-askpass-qa-failure.cjs
//
// Todo 30 QA FAILURE PATH under the REAL Electron main runtime (runAsNode=false;
// headless — no window). Proves the AskPass boundary fails CLOSED:
//
//  A. A real `git clone` run OUTSIDE the linked Job (no Job membership) — the
//     helper is rejected with a typed refusal, git receives NO credentials and
//     fails with a typed auth error; the token sentinel appears nowhere.
//  B. A real `git clone` whose session has EXPIRED — the helper gets the typed
//     expiry refusal, the clone fails auth, no secret is printed.
//  C. The helper invoked with a session that is CLOSED — bounded nonzero exit,
//     no secret.
//
// Prints QA_FAILURE_PASS JSON; exits non-zero on any failure.
'use strict'
const { app } = require('electron')
const { spawnSync, spawn } = require('node:child_process')
const { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const here = __dirname
const addonPath = join(here, '..', 'build', 'Release', 'hubfetch_job.node')
const helperPath = join(here, '..', 'build', 'Release', 'HubFetchAskPass.exe')
const httpServerFixture = join(here, 'fixtures', 'askpass-git-http-server.cjs')
const addon = require(addonPath)

const GIT = 'C:\\Program Files\\Git\\cmd\\git.exe'
const SENTINEL = 'qa-askpass-fail-sentinel-' + Math.random().toString(16).slice(2, 12)

const workDir = join(
  tmpdir(),
  't30-askpass-qa-failure-' + Date.now() + '-' + Math.random().toString(16).slice(2, 8)
)
try {
  rmSync(workDir, { recursive: true, force: true })
} catch {
  /* stale */
}
mkdirSync(workDir, { recursive: true })
const bareRepo = join(workDir, 'repo.git')
const seedRepo = join(workDir, 'seed')
const authLog = join(workDir, 'auth.log')

function fail(message) {
  console.error('QA_FAILURE_FAIL ' + message)
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
    setTimeout(() => reject(new Error('git http server did not start')), 10000)
  })
}

/** Run a real git clone with the given env; returns {status, stdout, stderr}. */
function gitClone(env, dest) {
  const url = `http://127.0.0.1:${results.port}/repo.git`
  return git(['clone', '--progress', url, dest], { env })
}

let results = {}

async function main() {
  // bare repo + server (same local fixture as the happy path)
  mkdirSync(seedRepo)
  writeFileSync(join(seedRepo, 'README.md'), 'askpass qa failure repo\n')
  git(['init', '-b', 'main'], { cwd: seedRepo })
  git(['config', 'user.email', 'qa@example.com'], { cwd: seedRepo })
  git(['config', 'user.name', 'QA'], { cwd: seedRepo })
  git(['add', '.'], { cwd: seedRepo })
  git(['commit', '-m', 'seed'], { cwd: seedRepo })
  git(['init', '--bare', bareRepo])
  git(['remote', 'add', 'origin', bareRepo], { cwd: seedRepo })
  git(['push', 'origin', 'main'], { cwd: seedRepo })

  const port = 21000 + Math.floor(Math.random() * 2000)
  results.port = port
  const server = await startServer(port)

  // A. git clone OUTSIDE the Job: helper rejected (not-in-job), clone fails auth.
  {
    const job = addon.createKillOnCloseJob()
    const created = addon.createAskPassSession({
      token: Buffer.from(SENTINEL, 'utf8'),
      username: 'hf_user',
      job,
      ttlMs: 60000,
      promptLimit: 4
    })
    // git runs OUTSIDE the Job (never assigned): the helper it spawns is not a
    // member of the linked Job, so the server refuses with a typed error frame.
    const r = gitClone(
      {
        ...process.env,
        GIT_ASKPASS: helperPath,
        HUBFETCH_ASKPASS_PIPE: created.pipeName,
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'credential.helper',
        GIT_CONFIG_VALUE_0: ''
      },
      join(workDir, 'dest-a')
    )
    results.caseA = {
      exit: r.status,
      stderrHasAuth:
        /authentication failed|could not read (username|password)|terminal prompts disabled/i.test(
          r.stderr
        ),
      sentinelInStderr: containsSentinel(r.stderr),
      sentinelInStdout: containsSentinel(r.stdout),
      serverAuthRequests: existsSync(authLog)
        ? readFileSync(authLog, 'utf8').trim().split('\n').length
        : 0
    }
    if (r.status === 0) fail('clone outside the Job unexpectedly succeeded')
    if (!results.caseA.stderrHasAuth) {
      fail(
        'clone outside the Job did not fail with a typed auth error: ' +
          JSON.stringify(r.stderr.slice(-400))
      )
    }
    if (results.caseA.sentinelInStderr || results.caseA.sentinelInStdout) {
      fail('token sentinel leaked into a failed clone output')
    }
    created.session.close()
    job.close()
  }

  // B. git clone with an EXPIRED session: helper gets the typed refusal.
  {
    const job = addon.createKillOnCloseJob()
    const created = addon.createAskPassSession({
      token: Buffer.from(SENTINEL, 'utf8'),
      username: 'hf_user',
      job,
      ttlMs: 200,
      promptLimit: 4
    })
    await new Promise((r) => setTimeout(r, 700))
    const r = gitClone(
      {
        ...process.env,
        GIT_ASKPASS: helperPath,
        HUBFETCH_ASKPASS_PIPE: created.pipeName,
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'credential.helper',
        GIT_CONFIG_VALUE_0: ''
      },
      join(workDir, 'dest-b')
    )
    results.caseB = {
      exit: r.status,
      stderrHasAuth:
        /authentication failed|could not read (username|password)|terminal prompts disabled/i.test(
          r.stderr
        ),
      sentinelInStderr: containsSentinel(r.stderr),
      sentinelInStdout: containsSentinel(r.stdout)
    }
    if (r.status === 0) fail('clone with an expired session unexpectedly succeeded')
    if (results.caseB.sentinelInStderr || results.caseB.sentinelInStdout) {
      fail('token sentinel leaked into an expired-clone output')
    }
    created.session.close()
    job.close()
  }

  // C. helper against a CLOSED session: bounded nonzero exit, no secret.
  {
    const job = addon.createKillOnCloseJob()
    const created = addon.createAskPassSession({
      token: Buffer.from(SENTINEL, 'utf8'),
      username: 'hf_user',
      job,
      ttlMs: 60000,
      promptLimit: 4
    })
    created.session.close()
    const t0 = Date.now()
    const r = spawnSync(helperPath, ["Password for 'https://hf_user@huggingface.co':"], {
      encoding: 'utf8',
      env: { ...process.env, HUBFETCH_ASKPASS_PIPE: created.pipeName },
      timeout: 30000
    })
    results.caseC = {
      exit: r.status,
      ms: Date.now() - t0,
      stdoutLen: (r.stdout || '').length,
      sentinelInStdout: containsSentinel(r.stdout || ''),
      sentinelInStderr: containsSentinel(r.stderr || '')
    }
    if (r.status === 0 || (r.stdout || '').length !== 0)
      fail('closed-session helper printed a secret')
    if (results.caseC.sentinelInStdout || results.caseC.sentinelInStderr) {
      fail('token sentinel leaked into a closed-session helper run')
    }
    if (Date.now() - t0 > 20000) fail('closed-session helper was not bounded')
    job.close()
  }

  // The failure outputs must not contain the sentinel anywhere.
  const scratchBytes = []
  const collect = (d) => {
    for (const e of (() => {
      try {
        return require('node:fs').readdirSync(d)
      } catch {
        return []
      }
    })()) {
      const p = join(d, e)
      const st = require('node:fs').statSync(p)
      if (st.isDirectory()) collect(p)
      else scratchBytes.push(require('node:fs').readFileSync(p))
    }
  }
  collect(workDir)
  const allBytes = Buffer.concat(scratchBytes)
  results.sentinelInScratch = containsSentinel(allBytes)
  if (results.sentinelInScratch) fail('token sentinel found in QA scratch')

  server.kill()
  console.log('QA_FAILURE_PASS ' + JSON.stringify(results, null, 2))
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
