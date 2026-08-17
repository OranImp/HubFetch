// apps/desktop/native/windows/test/fixtures/askpass-runner.cjs
//
// Todo 30 fixture: the Job-gated AskPass helper spawner.
//
// Protocol (driver <-> runner):
//   runner -> driver: "READY <pid>\n"
//   driver assigns this PID to the linked Job, then writes "GO\n" to stdin
//   runner spawns HubFetchAskPass.exe (now Job-bound), prints:
//     HELPER_STATUS=<code> HELPER_STDOUT=<b64> HELPER_STDERR=<...>
//
// With NO_JOB=1 the runner skips the GO gate (foreign-client case): the helper
// is spawned by a process that is NOT a member of the linked Job. With RAW=1
// the runner performs the client exchange itself via a message-mode raw client
// (for protocol-level cases like prompt-limit/TTL that bypass the classifier).
'use strict'
const { spawnSync } = require('node:child_process')
const fs = require('fs')

const helperPath = process.argv[2]
const prompt = process.argv[3]
const pipeName = process.argv[4]
const noJob = process.env.NO_JOB === '1'
const rawMode = process.env.RAW === '1'

function runHelper() {
  const env = { ...process.env, HUBFETCH_ASKPASS_PIPE: pipeName }
  const r = spawnSync(helperPath, [prompt], { env, encoding: 'utf8', timeout: 30000 })
  process.stdout.write(
    `HELPER_STATUS=${r.status}\n` +
      `HELPER_STDOUT=${Buffer.from(r.stdout || '').toString('base64')}\n` +
      `HELPER_STDERR=${(r.stderr || '').trim()}\n`
  )
  process.exit(0)
}

function rawExchange() {
  // Message-mode raw client: writes the request byte, reads the response
  // message (the whole [status][len][payload] frame arrives as one message).
  const result = { status: -1, out: '', err: '' }
  try {
    const fd = fs.openSync('\\\\.\\pipe\\' + pipeName, 'r+')
    const req = Buffer.from([prompt.startsWith('U') ? 0x55 : 0x50])
    fs.writeSync(fd, req, 0, 1, 0)
    const frame = Buffer.alloc(5 + 64 * 1024)
    let got = 0
    const deadline = Date.now() + 10000
    while (got < frame.length && Date.now() < deadline) {
      const n = fs.readSync(fd, frame, got, frame.length - got, null)
      if (n === 0) break
      got += n
      if (got >= 5) {
        const len = frame.readUInt32LE(1)
        if (got >= 5 + len) break
      }
    }
    if (got < 5) throw new Error('short read ' + got)
    const status = frame[0]
    const len = frame.readUInt32LE(1)
    if (got < 5 + len) throw new Error('short payload ' + got + '/' + (5 + len))
    if (status === 0x4f) result.out = frame.slice(5, 5 + len).toString('utf8')
    else if (status === 0x45) result.err = String.fromCharCode(frame[5])
    fs.closeSync(fd)
    result.status = status === 0x4f ? 0 : 1
  } catch (e) {
    result.err = e.message
    result.status = 1
  }
  process.stdout.write(
    `HELPER_STATUS=${result.status}\n` +
      `HELPER_STDOUT=${Buffer.from(result.out).toString('base64')}\n` +
      `HELPER_STDERR=${result.err}\n`
  )
  process.exit(0)
}

process.stdout.write(`READY ${process.pid}\n`)
if (noJob) {
  if (rawMode) rawExchange()
  else runHelper()
  return
}
process.stdin.resume()
process.stdin.on('data', (chunk) => {
  if (chunk.toString().includes('GO')) {
    if (rawMode) rawExchange()
    else runHelper()
  }
})
// Safety net: never outlive the test run.
setTimeout(() => process.exit(2), 60000).unref()
