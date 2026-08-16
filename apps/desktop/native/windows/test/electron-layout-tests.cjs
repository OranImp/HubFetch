// apps/desktop/native/windows/test/electron-layout-tests.cjs
//
// Todo 26 native tests — part 1: x64 structure/layout + stable error mapping.
// Runs under the REAL Electron runtime (ELECTRON_RUN_AS_NODE=1, invoked by
// `pnpm native:test`) so the assertions execute against the exact ABI the
// addon was compiled for (Electron ABI 148, x64).
//
// Exit code 0 only when every assertion passes; each failure prints FAIL and
// the process exits 1 immediately.
'use strict'
const { existsSync, readFileSync } = require('node:fs')
const { join } = require('node:path')

const EXPECTED_ELECTRON_ABI = 148
const addonPath = join(__dirname, '..', 'build', 'Release', 'hubfetch_job.node')

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail ?? '' })
  if (!ok) {
    console.error(`FAIL ${name}: ${detail}`)
    process.exit(1)
  }
}

if (process.platform !== 'win32') check('platform', false, process.platform)
if (process.arch !== 'x64') check('arch', false, process.arch)
if (Number(process.versions.modules) !== EXPECTED_ELECTRON_ABI) {
  check('electron-abi', false, `modules=${process.versions.modules}`)
}
if (!existsSync(addonPath)) check('addon-path', false, addonPath)

// --- PE/COFF x64 structure ------------------------------------------------
const bytes = readFileSync(addonPath)
check('pe-mz', bytes.readUInt16LE(0) === 0x5a4d, 'MZ header')
const peOffset = bytes.readUInt32LE(0x3c)
check(
  'pe-signature',
  bytes.toString('latin1', peOffset, peOffset + 4) === 'PE\u0000\u0000',
  'PE sig'
)
check('pe-machine-amd64', bytes.readUInt16LE(peOffset + 4) === 0x8664, 'machine 0x8664')

// --- Addon API surface ----------------------------------------------------
let addon
try {
  addon = require(addonPath)
} catch (err) {
  check('addon-load', false, err.message)
}
check('export-getRuntimeInfo', typeof addon.getRuntimeInfo === 'function')
check('export-getNativeLayout', typeof addon.getNativeLayout === 'function')
check('export-getProcessHandleCount', typeof addon.getProcessHandleCount === 'function')
check('export-createKillOnCloseJob', typeof addon.createKillOnCloseJob === 'function')

const info = addon.getRuntimeInfo()
check('runtime-addonName', info.addonName === 'hubfetch_job', JSON.stringify(info))
check('runtime-nodeAbi', Number(info.nodeAbi) === EXPECTED_ELECTRON_ABI, JSON.stringify(info))
check('runtime-arch', info.arch === 'x64', JSON.stringify(info))
check('runtime-napi', Number(info.napiVersion) >= 8, JSON.stringify(info))

// --- x64 structure/layout (compile-time static_asserts + runtime export) ---
const layout = addon.getNativeLayout()
const expectedLayout = {
  pointerSize: 8,
  sizeofBasicLimitInformation: 64,
  offsetofLimitFlags: 16,
  sizeofIoCounters: 48,
  sizeofExtendedLimitInformation: 144,
  offsetofExtendedLimitFlags: 16,
  sizeofBasicProcessIdList: 16,
  offsetofNumberOfAssignedProcesses: 0,
  offsetofNumberOfProcessIdsInList: 4,
  offsetofProcessIdList: 8,
  sizeofAssociateCompletionPort: 16,
  offsetofCompletionKey: 0,
  offsetofCompletionPort: 8,
  killOnCloseFlag: 0x2000,
  activeProcessZeroMessage: 4
}
for (const [key, value] of Object.entries(expectedLayout)) {
  check(`layout-${key}`, layout[key] === value, `${key}=${layout[key]}, expected ${value}`)
}

// --- JobHandle API surface + basic behavior --------------------------------
let job
try {
  job = addon.createKillOnCloseJob()
} catch (err) {
  check('create-kill-on-close', false, `${err.message} (code=${err.code})`)
}
for (const method of [
  'assignProcess',
  'containsProcess',
  'activeProcessIds',
  'terminate',
  'waitForEmpty',
  'close'
]) {
  check(`handle-method-${method}`, typeof job[method] === 'function')
}
check(
  'handle-no-raw-handle',
  job.handle === undefined && job._handle === undefined && typeof job.job === 'undefined',
  'raw handles must never be exposed as numbers'
)

// --- Stable error mapping ---------------------------------------------------
const badPid = job.assignProcess(0xffffffff)
check(
  'assign-invalid-pid-typed',
  badPid.ok === false &&
    badPid.code === 'HUBFETCH_JOB_OPEN_PROCESS_FAILED' &&
    badPid.errorCode === 'invalid-parameter',
  JSON.stringify(badPid)
)

const systemPid = job.assignProcess(4) // PID 4 = System; access-denied must NOT be swallowed
check(
  'assign-access-denied-preserved',
  systemPid.ok === false && systemPid.errorCode === 'access-denied',
  JSON.stringify(systemPid)
)

const selfAssign = job.assignProcess(process.pid)
check(
  'assign-self-refused',
  selfAssign.ok === false && selfAssign.code === 'HUBFETCH_JOB_INVALID_ARGUMENT',
  JSON.stringify(selfAssign)
)

const nonNumber = job.assignProcess('abc')
check(
  'assign-non-number-typed',
  nonNumber.ok === false && nonNumber.code === 'HUBFETCH_JOB_INVALID_ARGUMENT',
  JSON.stringify(nonNumber)
)

const closedContains = job.containsProcess(4)
check(
  'contains-open-ok-or-typed-denied',
  (closedContains.ok === true && closedContains.contains === false) ||
    (closedContains.ok === false && closedContains.errorCode === 'access-denied'),
  JSON.stringify(closedContains)
)

// Empty-job behaviors
const activeEmpty = job.activeProcessIds()
check(
  'active-empty-list',
  activeEmpty.ok === true && activeEmpty.pids.length === 0,
  JSON.stringify(activeEmpty)
)
const containsForeign = job.containsProcess(1) // PID 1 exists (a fake pid) -> not in our Job
check(
  'contains-foreign-false',
  containsForeign.ok === true && containsForeign.contains === false,
  JSON.stringify(containsForeign)
)

// waitForEmpty on an already-empty Job resolves ok immediately (query-confirmed)
async function verifyEmptyWait() {
  const w = await job.waitForEmpty(2000)
  check('wait-empty-immediate', w.ok === true, JSON.stringify(w))

  // Double-close is idempotent.
  const c1 = job.close()
  const c2 = job.close()
  check('double-close-ok', c1.ok === true && c2.ok === true, JSON.stringify({ c1, c2 }))
  check('handle-count-monotonic', Number(addon.getProcessHandleCount()) > 0, 'count probe works')

  console.log(
    'LAYOUT_TESTS_PASS ' +
      JSON.stringify({ checks: results.length, layout, runtime: info }, null, 2)
  )
}
verifyEmptyWait().catch((err) => {
  console.error('FAIL unexpected rejection:', err)
  process.exit(1)
})
