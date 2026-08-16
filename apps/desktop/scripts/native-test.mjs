// apps/desktop/scripts/native-test.mjs
//
// Todo 25: runs the native smoke probe under the REAL Electron runtime
// (ELECTRON_RUN_AS_NODE=1) so the Electron-ABI build actually loads. The probe
// exits 0 only when every assertion passes; this script forwards that real exit
// code (spawnSync, no cmd %errorlevel% parse-time trap).
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

const probe = join(NATIVE, 'test', 'electron-abi-probe.cjs')
const run = spawnSync(electronPath, [probe], {
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    TMP: 'E:\\Programs\\Temp',
    TEMP: 'E:\\Programs\\Temp'
  },
  stdio: 'inherit'
})
process.exit(run.status ?? 1)
