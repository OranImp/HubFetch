// apps/desktop/native/windows/test/electron-askpass-addon-tests.cjs
//
// Todo 30: AskPass session semantics under the REAL Electron runtime
// (ELECTRON_RUN_AS_NODE). Covers the acceptance matrix that is purely
// native-side:
//   - session shape: 256-bit random pipe name, stats, current-user+SYSTEM DACL
//   - username / password prompts served to Job members (via the runner
//     fixture: the runner is assigned to the linked Job BEFORE the helper runs)
//   - repeated allowed prompts within the limit
//   - TTL expiry: helper after the session TTL gets a typed refusal, no secret
//   - prompt limit: prompts past the limit are refused typed
//   - foreign client (NOT in the Job) is rejected with no secret
//   - a foreign client connected FIRST does not poison the session: the next
//     legitimate Job member is still served
//   - pipe disconnect mid-prompt: a client that disconnects without sending a
//     request does not break the session
//   - zeroization: after close(), token/username buffers are cleared, the Job
//     duplicate is released, and no server remains
//   - token single-line contract enforced at creation
//
// Prints ASKPASS_ADDON_PASS JSON; exits non-zero on any failure.
'use strict'
const { spawn } = require('node:child_process')
const { join } = require('node:path')

const addonPath = join(__dirname, '..', 'build', 'Release', 'hubfetch_job.node')
const helperPath = join(__dirname, '..', 'build', 'Release', 'HubFetchAskPass.exe')
const runnerPath = join(__dirname, 'fixtures', 'askpass-runner.cjs')

const addon = require(addonPath)

function fail(message) {
  console.error('ASKPASS_ADDON_FAIL ' + message)
  process.exit(1)
}

const FAKE_TOKEN = 'native-test-token-123456'
const FAKE_USER = 'hf_user'

function createSession(overrides = {}) {
  const job = addon.createKillOnCloseJob()
  const tokenBuffer = Buffer.from(FAKE_TOKEN, 'utf8')
  const created = addon.createAskPassSession({
    token: tokenBuffer,
    username: FAKE_USER,
    job,
    ttlMs: 30000,
    promptLimit: 4,
    allowUsername: true,
    allowPassword: true,
    ...overrides
  })
  tokenBuffer.fill(0)
  if (!created || typeof created.pipeName !== 'string') fail('createAskPassSession shape')
  return { job, ...created }
}

/** Spawn the runner, assign it to the Job, release the helper, collect output. */
function runHelper(pipeName, job, prompt, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runnerPath, helperPath, prompt, pipeName], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...extraEnv },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d.toString()))
    child.stderr.on('data', (d) => (err += d.toString()))
    const ready = new Promise((res) => {
      const timer = setInterval(() => {
        const m = /READY (\d+)/.exec(out)
        if (m) {
          clearInterval(timer)
          res(Number(m[1]))
        }
      }, 20)
      setTimeout(() => {
        clearInterval(timer)
        res(null)
      }, 5000)
    })
    ready.then((pid) => {
      if (pid === null) {
        reject(new Error('runner did not report READY: ' + out + err))
        return
      }
      const assign = job.assignProcess(pid)
      if (!assign.ok) {
        reject(new Error('assign failed: ' + JSON.stringify(assign)))
        return
      }
      const contains = job.containsProcess(pid)
      if (!contains.ok || !contains.contains) {
        reject(new Error('not in Job after assign'))
        return
      }
      child.stdin.write('GO\n')
    })
    const timer = setTimeout(() => {
      reject(new Error('runner timeout: ' + out + err))
      child.kill()
    }, 30000)
    child.on('exit', () => {
      clearTimeout(timer)
      const m = /HELPER_STATUS=(\d+)\nHELPER_STDOUT=(.*)\nHELPER_STDERR=(.*)\n/.exec(out)
      if (!m) {
        reject(new Error('runner output malformed: ' + out + err))
        return
      }
      resolve({
        code: Number(m[1]),
        stdout: Buffer.from(m[2], 'base64').toString('utf8'),
        stderr: m[3]
      })
    })
  })
}

async function main() {
  const results = {}
  let step = 0
  const mark = () => {
    step += 1
    process.stderr.write('[addon-test step ' + step + ']\n')
  }

  // 1. Session shape + DACL
  {
    mark()
    const s = createSession()
    results.sessionShape = {
      pipeName: s.pipeName,
      length: s.pipeName.length,
      random256: /^HubFetchAskPass-[0-9a-f]{64}$/.test(s.pipeName)
    }
    if (!results.sessionShape.random256 || results.sessionShape.length !== 16 + 64) {
      fail('pipe name is not a 256-bit random locator: ' + s.pipeName)
    }
    const dacl = s.session.stats().pipeDaclSddl
    results.dacl = dacl
    if (!/^D:P\(A;;GA;;;SY\)\(A;;GA;;;S-1-5-21-/.test(dacl)) fail('DACL unexpected: ' + dacl)
    s.session.close()
    s.job.close()
  }

  // 2. username + password prompts served to Job members
  {
    mark()
    const s = createSession()
    const u = await runHelper(s.pipeName, s.job, "Username for 'https://huggingface.co':")
    const p = await runHelper(s.pipeName, s.job, "Password for 'https://hf_user@huggingface.co':")
    results.prompts = { username: { code: u.code, out: u.stdout }, password: { code: p.code } }
    if (u.code !== 0 || u.stdout.trim() !== FAKE_USER) fail('username not served')
    if (p.code !== 0 || p.stdout.trim() !== FAKE_TOKEN) fail('password (token) not served')
    const stats = s.session.stats()
    if (stats.promptsServed < 2) fail('promptsServed=' + stats.promptsServed)
    s.session.close()
    s.job.close()
  }

  // 3. repeated allowed prompts within the limit
  {
    mark()
    const s = createSession({ promptLimit: 3 })
    for (let i = 0; i < 3; i++) {
      const r = await runHelper(s.pipeName, s.job, "Username for 'https://huggingface.co':")
      if (r.code !== 0 || r.stdout.trim() !== FAKE_USER) fail('repeated prompt ' + i + ' failed')
    }
    results.repeatedPrompts = s.session.stats().promptsServed
    if (s.session.stats().promptsServed !== 3) fail('prompt count mismatch')
    s.session.close()
    s.job.close()
  }

  // 4. prompt limit: the 4th prompt is refused typed, no secret
  {
    mark()
    const s = createSession({ promptLimit: 2 })
    await runHelper(s.pipeName, s.job, "Username for 'https://huggingface.co':")
    await runHelper(s.pipeName, s.job, "Username for 'https://huggingface.co':")
    const third = await runHelper(s.pipeName, s.job, "Username for 'https://huggingface.co':")
    results.promptLimit = third
    if (third.code === 0 || third.stdout.length !== 0) fail('limit not enforced')
    s.session.close()
    s.job.close()
  }

  // 5. TTL: helper after expiry gets a typed refusal, no secret
  {
    mark()
    const s = createSession({ ttlMs: 300 })
    await new Promise((r) => setTimeout(r, 800))
    const late = await runHelper(s.pipeName, s.job, "Username for 'https://huggingface.co':")
    results.afterExpiry = late
    if (late.code === 0 || late.stdout.length !== 0) fail('expired session still served')
    s.session.close()
    s.job.close()
  }

  // 6. foreign client (NOT in the Job) rejected with no secret
  {
    mark()
    const s = createSession()
    const foreign = await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [runnerPath, helperPath, "Password for 'https://hf_user@huggingface.co':", s.pipeName],
        {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NO_JOB: '1' },
          stdio: ['ignore', 'pipe', 'pipe']
        }
      )
      let out = ''
      child.stdout.on('data', (d) => (out += d.toString()))
      child.on('exit', () => {
        const m = /HELPER_STATUS=(\d+)\nHELPER_STDOUT=(.*)\nHELPER_STDERR=(.*)\n/.exec(out)
        if (!m) reject(new Error('foreign runner output malformed: ' + out))
        else resolve({ code: Number(m[1]), stdout: Buffer.from(m[2], 'base64').toString('utf8') })
      })
      setTimeout(() => reject(new Error('foreign runner timeout')), 30000)
    })
    results.foreign = foreign
    // exit 2 (write raced the reject+disconnect) or 3 (typed refusal) both fail closed.
    if ((foreign.code !== 2 && foreign.code !== 3) || foreign.stdout.length !== 0) {
      fail('foreign client not rejected: ' + JSON.stringify(foreign))
    }
    if (s.session.stats().rejected < 1) fail('reject count not recorded')
    s.session.close()
    s.job.close()
  }

  // 7. concurrent foreign client first, then a legitimate Job member is served
  {
    mark()
    const s = createSession({ promptLimit: 4 })
    const foreign = await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [runnerPath, helperPath, "Username for 'https://huggingface.co':", s.pipeName],
        {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NO_JOB: '1' },
          stdio: ['ignore', 'pipe', 'pipe']
        }
      )
      let out = ''
      child.stdout.on('data', (d) => (out += d.toString()))
      child.on('exit', () => {
        const m = /HELPER_STATUS=(\d+)\nHELPER_STDOUT=(.*)\n/.exec(out)
        resolve({ code: Number(m[1]), stdout: Buffer.from(m[2], 'base64').toString('utf8') })
      })
      setTimeout(() => reject(new Error('foreign runner timeout')), 30000)
    })
    const legit = await runHelper(s.pipeName, s.job, "Username for 'https://huggingface.co':")
    results.concurrentForeignThenLegit = { foreign: foreign.code, legit: legit.code }
    if (legit.code !== 0 || legit.stdout.trim() !== FAKE_USER) {
      fail('legitimate client not served after a foreign client: ' + JSON.stringify(legit))
    }
    s.session.close()
    s.job.close()
  }

  // 8. pipe disconnect mid-prompt: client disconnects without sending a request
  {
    mark()
    const s = createSession({ promptLimit: 4 })
    const disconnected = await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          '-e',
          `
        const fs = require('fs')
        try {
          const fd = fs.openSync('\\\\\\\\\\\\.\\\\\\\\pipe\\\\\\\\' + process.argv[1], 'r+')
          // connect, write nothing, close immediately
          fs.closeSync(fd)
        } catch (e) { /* never mind */ }
        process.exit(0)
      `,
          s.pipeName
        ],
        {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          stdio: 'ignore'
        }
      )
      child.on('exit', resolve)
      child.on('error', reject)
      setTimeout(() => reject(new Error('disconnect client timeout')), 15000)
    })
    void disconnected
    // The session must survive and serve the next legitimate client.
    const legit = await runHelper(s.pipeName, s.job, "Username for 'https://huggingface.co':")
    results.disconnectMidPromptThenLegit = legit.code
    if (legit.code !== 0 || legit.stdout.trim() !== FAKE_USER) {
      fail('session broken by a mid-prompt disconnect: ' + JSON.stringify(legit))
    }
    s.session.close()
    s.job.close()
  }

  // 9. zeroization + no server after close
  {
    mark()
    const s = createSession()
    await runHelper(s.pipeName, s.job, "Username for 'https://huggingface.co':")
    const before = s.session.zeroizeProof()
    if (before.tokenCleared !== false) fail('token cleared before close?')
    s.session.close()
    const after = s.session.zeroizeProof()
    results.zeroize = after
    if (!after.tokenCleared || !after.usernameCleared || !after.jobHandleReleased) {
      fail('zeroize proof failed: ' + JSON.stringify(after))
    }
    const post = await runHelper(s.pipeName, s.job, "Username for 'https://huggingface.co':")
    results.postClose = post.code
    if (post.code === 0 || post.stdout.length !== 0) fail('server still serving after close')
    s.job.close()
  }

  // 10. multiline token rejected at creation
  {
    mark()
    let rejected = false
    const job = addon.createKillOnCloseJob()
    try {
      addon.createAskPassSession({
        token: Buffer.from('line1\nline2', 'utf8'),
        username: FAKE_USER,
        job,
        ttlMs: 1000,
        promptLimit: 2
      })
    } catch (err) {
      rejected = err && typeof err.code === 'string' && err.code.includes('MULTILINE')
    } finally {
      job.close()
    }
    results.multilineTokenRejected = rejected
    if (!rejected) fail('multiline token accepted at creation')
  }

  // 11. every session has a UNIQUE 256-bit pipe name (never reused)
  {
    mark()
    const a = createSession()
    const b = createSession()
    results.uniquePipeNames = a.pipeName !== b.pipeName
    if (!results.uniquePipeNames) fail('pipe name reused across sessions')
    a.session.close()
    a.job.close()
    b.session.close()
    b.job.close()
  }

  console.log('ASKPASS_ADDON_PASS ' + JSON.stringify(results, null, 2))
  process.exit(0)
}

main().catch((err) => fail(err && err.stack ? err.stack : String(err)))
