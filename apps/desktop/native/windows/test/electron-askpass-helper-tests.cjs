// apps/desktop/native/windows/test/electron-askpass-helper-tests.cjs
//
// Todo 30: the packaged HubFetchAskPass.exe console helper.
//   - it is an x64 console PE (packaging contract)
//   - prompt classification: username / HTTPS password / SSH password /
//     passphrase prompts are answered; any other prompt is refused (exit 1)
//   - unknown / unavailable pipe: bounded nonzero exit, typed stderr, NO secret
//   - missing HUBFETCH_ASKPASS_PIPE: exit 1 with typed stderr
//   - a server-refusal error frame maps to a nonzero exit with NO secret
//
// Prints ASKPASS_HELPER_PASS JSON; exits non-zero on any failure.
'use strict'
const { spawnSync } = require('node:child_process')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const helperPath = join(__dirname, '..', 'build', 'Release', 'HubFetchAskPass.exe')
const addonPath = join(__dirname, '..', 'build', 'Release', 'hubfetch_job.node')

function fail(message) {
  console.error('ASKPASS_HELPER_FAIL ' + message)
  process.exit(1)
}

/** Run the helper once with the given argv/env; returns {status, stdout, stderr}. */
function run(argv, env = {}) {
  const r = spawnSync(helperPath, argv, {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, ...env }
  })
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' }
}

function main() {
  const results = {}

  // 1. x64 console PE
  {
    const b = readFileSync(helperPath)
    const pe = b.readUInt32LE(0x3c)
    const machine = b.readUInt16LE(pe + 4)
    const magic = b.readUInt16LE(pe + 0x18)
    const subsystem = b.readUInt16LE(pe + 0x5c)
    results.pe = { machine, magic, subsystem }
    if (machine !== 0x8664) fail('helper is not x64 (machine 0x' + machine.toString(16) + ')')
    if (magic !== 0x20b) fail('helper is not PE32+')
    if (subsystem !== 3) fail('helper is not a CONSOLE subsystem binary (got ' + subsystem + ')')
  }

  // 2. usage: zero prompt args → exit 1, typed stderr
  {
    const r = run([])
    results.usage = { status: r.status, stderr: r.stderr.trim() }
    if (r.status !== 1) fail('usage exit should be 1')
    if (!/expected exactly one prompt/.test(r.stderr)) fail('usage stderr not typed')
  }

  // 3. missing pipe locator → exit 1, typed stderr
  {
    const r = run(["Username for 'https://huggingface.co':"], {})
    results.noLocator = { status: r.status, stderr: r.stderr.trim() }
    if (r.status !== 1) fail('missing locator exit should be 1')
    if (!/no pipe locator/.test(r.stderr)) fail('missing locator stderr not typed')
  }

  // 4. unknown prompt class → exit 1, no secret
  {
    const r = run(['Enter host key fingerprint for git@hf.co:'], {
      HUBFETCH_ASKPASS_PIPE: 'HubFetchAskPass-' + '0'.repeat(64)
    })
    results.unknownPrompt = { status: r.status, stdout: r.stdout, stderr: r.stderr.trim() }
    if (r.status !== 1) fail('unknown prompt should be refused (exit 1)')
    if (r.stdout.length !== 0) fail('unknown prompt must not print a secret')
  }

  // 5. unknown pipe → bounded nonzero exit, typed stderr, no secret
  {
    const t0 = Date.now()
    const r = run(["Username for 'https://huggingface.co':"], {
      HUBFETCH_ASKPASS_PIPE: 'HubFetchAskPass-Nope-' + '1'.repeat(32)
    })
    results.unknownPipe = { status: r.status, ms: Date.now() - t0, stderr: r.stderr.trim() }
    if (r.status !== 2) fail('unknown pipe exit should be 2 (pipe unavailable)')
    if (r.stdout.length !== 0) fail('unknown pipe must not print a secret')
    if (Date.now() - t0 > 20000) fail('unknown pipe helper was not bounded')
  }

  // 6. a server that REFUSES maps to a typed nonzero exit with NO secret
  //    (a real session rejects foreign clients: not in the linked Job).
  {
    const addon = require(addonPath)
    const job = addon.createKillOnCloseJob()
    const created = addon.createAskPassSession({
      token: Buffer.from('helper-test-token', 'utf8'),
      username: 'hf_user',
      job,
      ttlMs: 30000,
      promptLimit: 4
    })
    const r = run(["Password for 'https://hf_user@huggingface.co':"], {
      HUBFETCH_ASKPASS_PIPE: created.pipeName
    })
    results.serverRefusal = { status: r.status, stdout: r.stdout, stderr: r.stderr.trim() }
    if (r.status === 0 || r.stdout.length !== 0) fail('server refusal leaked a secret')
    if (!/refused the request/.test(r.stderr)) fail('server refusal stderr not typed')
    created.session.close()
    job.close()
  }

  console.log('ASKPASS_HELPER_PASS ' + JSON.stringify(results, null, 2))
  process.exit(0)
}

main()
