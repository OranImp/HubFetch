// apps/desktop/native/windows/test/electron-qa-failure.cjs
//
// Todo 25 QA FAILURE PATH, run under the REAL Electron runtime. Substitutes a
// copied WRONG-ABI module (built for system Node ABI 137) and an EMPTY module,
// then asserts the loader returns a TYPED unavailable bridge and clone support
// stays disabled — without crashing the process.
//
// Fixture paths come from argv: [wrongAbiNodePath, emptyNodePath].
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

const [, , wrongAbiPath, emptyPath] = process.argv
if (!wrongAbiPath || !emptyPath) {
  console.error('QA_FAILURE_BAD_ARGS expected [wrongAbiNodePath, emptyNodePath]')
  process.exit(1)
}

const results = []

function runCase(name, fixturePath, expectCode) {
  const before = results.length
  let bridge
  try {
    bridge = loadHubFetchJob({
      overridePath: fixturePath,
      isPackaged: false,
      appPath: process.cwd(),
      platform: 'win32',
      arch: 'x64',
      modulesVersion: process.versions.modules,
      checkExists: existsSync
    })
  } catch (err) {
    results.push({
      name,
      outcome: 'FAIL',
      detail: `loader THREW (must never throw): ${err && err.message}`
    })
    return
  }
  const support = getCloneSupport(bridge)
  const ok =
    bridge.status === 'unavailable' &&
    bridge.code === expectCode &&
    support.enabled === false &&
    typeof support.reason === 'string'
  results.push({
    name,
    outcome: ok ? 'PASS' : 'FAIL',
    expectCode,
    bridge,
    cloneSupport: support,
    noCrash: results.length === before // still executing after the case => no crash
  })
}

runCase('wrong-abi-module', wrongAbiPath, 'wrong-abi')
runCase('empty-module', emptyPath, 'load-failed')

// After the failure cases the process is still alive => no crash.
results.push({ name: 'process-survives', outcome: 'PASS', noCrash: true })

const allPass = results.every((r) => r.outcome === 'PASS')
console.log(allPass ? 'QA_FAILURE_PASS' : 'QA_FAILURE_FAIL')
console.log(JSON.stringify(results, null, 2))
process.exit(allPass ? 0 : 1)
