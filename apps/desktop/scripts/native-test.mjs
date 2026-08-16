// apps/desktop/scripts/native-test.mjs
//
// Todo 25/26: runs the native test suites under the REAL Electron runtime
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
// --expose-gc is passed so the finalizer-safety test can force collection.
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

const suites = [
  { name: 'abi-probe', file: 'electron-abi-probe.cjs', exposeGc: false },
  { name: 'layout-tests', file: 'electron-layout-tests.cjs', exposeGc: false },
  { name: 'integration-tests', file: 'electron-integration-tests.cjs', exposeGc: true },
  { name: 'qa-happy', file: 'electron-qa-happy.cjs', exposeGc: false },
  { name: 'qa-failure', file: 'electron-qa-failure.cjs', exposeGc: false }
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
      ELECTRON_RUN_AS_NODE: '1',
      TMP: 'E:\\Programs\\Temp',
      TEMP: 'E:\\Programs\\Temp'
    },
    stdio: 'inherit'
  })
  if (run.status !== 0) {
    console.error(`[native-test] FAILED suite '${suite.name}' with exit code ${run.status ?? 1}`)
    process.exit(run.status ?? 1)
  }
}

console.log('[native-test] OK: all native suites passed under Electron ABI')
process.exit(0)
