// apps/desktop/scripts/native-test.mjs
//
// Todo 25/26/27: runs the native test suites under the REAL Electron runtime
// (ELECTRON_RUN_AS_NODE=1) so the Electron-ABI build actually loads. Every
// suite exits 0 only when its assertions pass; this script forwards each real
// exit code (spawnSync, no cmd %errorlevel% parse-time trap) and stops on the
// first failure.
//
// Suites (each runs as its own Electron process):
//   1. electron-abi-probe.cjs           — addon coverage (ABI/PE/API/bridge)
//   2. electron-layout-tests.cjs        — x64 structure/layout + error mapping
//   3. electron-integration-tests.cjs   — child+grandchild, timeout, double-
//                                         close, finalizer, handle growth
//   4. electron-qa-happy.cjs            — loader+real bridge happy path
//   5. electron-qa-failure.cjs          — typed failure path, no spawns
//   6. electron-clone-qa-happy.cjs      — Todo 27: real utilityProcess.fork +
//                                         CloneHost + real Job, cancel to zero
//   7. electron-clone-qa-failure.cjs    — Todo 27: assign rejected + forged
//                                         early start + tampered envelope,
//                                         git-spy stays zero
// --expose-gc is passed so the finalizer-safety test can force collection.
//
// Suites 6-7 run as a REAL Electron main process (no ELECTRON_RUN_AS_NODE):
// utilityProcess.fork only exists in the real main process. No window is ever
// created, so they are headless by construction (headless test policy).
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP = join(HERE, '..')
const NATIVE = join(DESKTOP, 'native', 'windows')

const require = createRequire(import.meta.url)

if (process.platform !== 'win32' || process.arch !== 'x64') {
  console.error('[native-test] ERROR: native test requires Windows x64')
  process.exit(1)
}

const staged = join(NATIVE, 'build', 'Release', 'hubfetch_job.node')
if (!existsSync(staged)) {
  console.error(`[native-test] ERROR: ${staged} missing; run pnpm native:build first`)
  process.exit(1)
}

const electronPath = require('electron')
if (typeof electronPath !== 'string' || !existsSync(electronPath)) {
  console.error(`[native-test] ERROR: electron runtime not found (resolved '${electronPath}')`)
  process.exit(1)
}

// runAsNode=true suites run with ELECTRON_RUN_AS_NODE=1; runAsNode=false suites
// run as a real Electron main process (headless: no window is created).
const suites = [
  { name: 'abi-probe', file: 'electron-abi-probe.cjs', exposeGc: false, runAsNode: true },
  { name: 'layout-tests', file: 'electron-layout-tests.cjs', exposeGc: false, runAsNode: true },
  {
    name: 'integration-tests',
    file: 'electron-integration-tests.cjs',
    exposeGc: true,
    runAsNode: true
  },
  { name: 'qa-happy', file: 'electron-qa-happy.cjs', exposeGc: false, runAsNode: true },
  { name: 'qa-failure', file: 'electron-qa-failure.cjs', exposeGc: false, runAsNode: true },
  {
    name: 'clone-qa-happy',
    file: 'electron-clone-qa-happy.cjs',
    exposeGc: false,
    runAsNode: false
  },
  {
    name: 'clone-qa-failure',
    file: 'electron-clone-qa-failure.cjs',
    exposeGc: false,
    runAsNode: false
  },
  {
    name: 'askpass-helper-tests',
    file: 'electron-askpass-helper-tests.cjs',
    exposeGc: false,
    runAsNode: true
  },
  {
    name: 'askpass-addon-tests',
    file: 'electron-askpass-addon-tests.cjs',
    exposeGc: false,
    runAsNode: true
  },
  {
    name: 'askpass-qa-happy',
    file: 'electron-askpass-qa-happy.cjs',
    exposeGc: false,
    runAsNode: false
  },
  {
    name: 'askpass-qa-failure',
    file: 'electron-askpass-qa-failure.cjs',
    exposeGc: false,
    runAsNode: false
  }
]

for (const suite of suites) {
  const script = join(NATIVE, 'test', suite.file)
  if (!existsSync(script)) {
    console.error(`[native-test] ERROR: suite script missing: ${script}`)
    process.exit(1)
  }
  const args = []
  if (suite.exposeGc) args.push('--expose-gc')
  args.push(script)
  console.log(`[native-test] === suite: ${suite.name} (${suite.file}) ===`)
  const run = spawnSync(electronPath, args, {
    env: {
      ...process.env,
      ...(suite.runAsNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
      TMP: 'E:\\Programs\\Temp',
      TEMP: 'E:\\Programs\\Temp',
      PLAYWRIGHT_BROWSERS_PATH: 'E:\\Programs\\ms-playwright'
    },
    stdio: 'inherit',
    timeout: 180_000
  })
  if (run.status !== 0) {
    console.error(`[native-test] FAILED suite '${suite.name}' with exit code ${run.status ?? 1}`)
    process.exit(run.status ?? 1)
  }
}

console.log('[native-test] OK: all native suites passed under Electron')
process.exit(0)
