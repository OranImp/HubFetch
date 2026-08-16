// apps/desktop/native/windows/test/electron-abi-probe.cjs
//
// Todo 26 addon-coverage test. Runs under the REAL Electron runtime
// (ELECTRON_RUN_AS_NODE=1, via `pnpm native:test`) so the addon loads against
// the Electron ABI it was compiled for. Asserts, with process exit codes:
//   - platform win32 / arch x64
//   - runtime ABI (process.versions.modules) == 148 (Electron 43.1.0)
//   - the compiled .node is a PE/COFF x64 (machine 0x8664) binary
//   - the addon loads and getRuntimeInfo() reports the matching ABI + arch
//   - createKillOnCloseJob() returns a working JobHandle (real bridge, not a
//     stub): methods present, empty-job waitForEmpty resolves ok, close is
//     idempotent
'use strict'
const { readFileSync, existsSync } = require('node:fs')
const { join } = require('node:path')

const EXPECTED_ELECTRON_ABI = 148
const EXPECTED_ARCH = 'x64'
const EXPECTED_PE_MACHINE_AMD64 = 0x8664

const addonPath = join(__dirname, '..', 'build', 'Release', 'hubfetch_job.node')

function fail(message) {
  console.error(`FAIL: ${message}`)
  process.exit(1)
}

if (process.platform !== 'win32') fail(`platform=${process.platform}, expected win32`)
if (process.arch !== EXPECTED_ARCH) fail(`process.arch=${process.arch}, expected ${EXPECTED_ARCH}`)
if (Number(process.versions.modules) !== EXPECTED_ELECTRON_ABI) {
  fail(`process.versions.modules=${process.versions.modules}, expected ${EXPECTED_ELECTRON_ABI}`)
}
if (!existsSync(addonPath)) fail(`addon not found at ${addonPath}`)

const bytes = readFileSync(addonPath)
if (bytes.readUInt16LE(0) !== 0x5a4d) fail('not a PE file (missing MZ header)')
const peOffset = bytes.readUInt32LE(0x3c)
if (bytes.toString('latin1', peOffset, peOffset + 4) !== 'PE\u0000\u0000') {
  fail('not a PE file (missing PE signature)')
}
const machine = bytes.readUInt16LE(peOffset + 4)
if (machine !== EXPECTED_PE_MACHINE_AMD64) {
  fail(`PE machine=0x${machine.toString(16)}, expected 0x${EXPECTED_PE_MACHINE_AMD64} (AMD64)`)
}

let addon
try {
  addon = require(addonPath)
} catch (err) {
  fail(`addon failed to load: ${err && err.message}`)
}

if (typeof addon.getRuntimeInfo !== 'function') fail('export getRuntimeInfo is not a function')
const info = addon.getRuntimeInfo()
const checks = {
  addonName: info.addonName === 'hubfetch_job',
  addonVersion: typeof info.addonVersion === 'string' && info.addonVersion.length > 0,
  nodeAbiMatchesRuntime: Number(info.nodeAbi) === EXPECTED_ELECTRON_ABI,
  archIsX64: info.arch === EXPECTED_ARCH,
  napiVersionAtLeast8: Number(info.napiVersion) >= 8,
  createKillOnCloseJobExport: typeof addon.createKillOnCloseJob === 'function',
  getNativeLayoutExport: typeof addon.getNativeLayout === 'function',
  getProcessHandleCountExport: typeof addon.getProcessHandleCount === 'function'
}
for (const [name, ok] of Object.entries(checks)) {
  if (!ok) fail(`assertion '${name}' failed: ${JSON.stringify(info)}`)
}

async function verifyBridge() {
  const job = addon.createKillOnCloseJob()
  for (const method of [
    'assignProcess',
    'containsProcess',
    'activeProcessIds',
    'terminate',
    'waitForEmpty',
    'close'
  ]) {
    if (typeof job[method] !== 'function') fail(`JobHandle method '${method}' is not a function`)
  }
  const active = job.activeProcessIds()
  if (!active.ok || !Array.isArray(active.pids) || active.pids.length !== 0) {
    fail(`fresh Job must have zero active processes: ${JSON.stringify(active)}`)
  }
  const emptyWait = await job.waitForEmpty(2000)
  if (!emptyWait.ok) fail(`empty-Job waitForEmpty must resolve ok: ${JSON.stringify(emptyWait)}`)
  const c1 = job.close()
  const c2 = job.close()
  if (!c1.ok || !c2.ok) fail(`close must be idempotent: ${JSON.stringify({ c1, c2 })}`)

  console.log(
    JSON.stringify(
      {
        ok: true,
        platform: process.platform,
        arch: process.arch,
        electron: process.versions.electron ?? 'electron-run-as-node',
        node: process.versions.node,
        modules: Number(process.versions.modules),
        peMachine: machine,
        peMachineHex: `0x${machine.toString(16)}`,
        runtimeInfo: info,
        bridge: {
          createKillOnCloseJob: 'real JobHandle (Todo 26)',
          emptyActivePids: active.pids,
          emptyWaitForEmpty: emptyWait,
          doubleClose: { c1, c2 }
        },
        addonPath,
        addonBytes: bytes.length
      },
      null,
      2
    )
  )
}

verifyBridge().catch((err) => {
  console.error(`FAIL: bridge verification rejected: ${err && err.message}`)
  process.exit(1)
})
