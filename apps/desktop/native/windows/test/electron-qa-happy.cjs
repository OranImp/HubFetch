// apps/desktop/native/windows/test/electron-qa-happy.cjs
//
// Todo 25 QA HAPPY PATH, run under the REAL Electron runtime
// (ELECTRON_RUN_AS_NODE=1, invoked via pnpm native:test scripts/electron-qa.mjs
// or directly with the electron binary). It bundles the actual main-process
// loader with esbuild, loads the real Electron-ABI addon through it, and asserts
// the ready bridge, version/export probe, and clone-support gate.
'use strict'
const { buildSync } = require('esbuild')
const { existsSync } = require('node:fs')
const { join } = require('node:path')

const loaderTs = join(
  __dirname,
  '..',
  '..',
  '..',
  'src',
  'main',
  'native',
  'hubfetch-job-loader.ts'
)
const outfile = join(__dirname, '..', 'build', 'qa-loader.cjs')

buildSync({
  entryPoints: [loaderTs],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  outfile,
  logLevel: 'silent'
})

const { getCloneSupport, loadHubFetchJob } = require(outfile)
const addonPath = join(__dirname, '..', 'build', 'Release', 'hubfetch_job.node')

if (process.platform !== 'win32' || process.arch !== 'x64') {
  console.error('QA_HAPPY_FAIL platform/arch not win32/x64')
  process.exit(1)
}
if (!existsSync(addonPath)) {
  console.error(`QA_HAPPY_FAIL addon missing: ${addonPath}`)
  process.exit(1)
}

const bridge = loadHubFetchJob({
  overridePath: addonPath,
  isPackaged: false,
  appPath: process.cwd(),
  platform: 'win32',
  arch: 'x64',
  modulesVersion: process.versions.modules,
  checkExists: existsSync
})

const report = {
  bridge,
  cloneSupport: getCloneSupport(bridge),
  modules: process.versions.modules,
  electron: process.versions.electron ?? 'run-as-node'
}

if (bridge.status !== 'ready') {
  console.error(`QA_HAPPY_FAIL loader did not report ready: ${JSON.stringify(report)}`)
  process.exit(1)
}
if (bridge.runtimeInfo.nodeAbi !== Number(process.versions.modules)) {
  console.error(`QA_HAPPY_FAIL ABI mismatch in ready bridge: ${JSON.stringify(report)}`)
  process.exit(1)
}
if (bridge.runtimeInfo.arch !== 'x64') {
  console.error(`QA_HAPPY_FAIL arch not x64: ${JSON.stringify(report)}`)
  process.exit(1)
}
if (getCloneSupport(bridge).enabled !== true) {
  console.error(
    `QA_HAPPY_FAIL clone support not enabled on ready bridge: ${JSON.stringify(report)}`
  )
  process.exit(1)
}

// Version/export probe through the REAL addon (not the loader's fake).
const mod = require(addonPath)
const stub = mod.createKillOnCloseJob()
if (!stub || stub.status !== 'not-implemented') {
  console.error(`QA_HAPPY_FAIL unexpected stub: ${JSON.stringify(stub)}`)
  process.exit(1)
}

console.log('QA_HAPPY_PASS ' + JSON.stringify({ ...report, stub }, null, 2))
