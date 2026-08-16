// apps/desktop/scripts/native-build.mjs
//
// Todo 25: builds the `hubfetch_job` Node-API addon for the Electron ABI only.
// Fails hard (non-zero real exit code via spawnSync) on any non-Windows /
// non-x64 environment so release can never produce a foreign binary.
//
//   - Pins node-addon-api to the EXACT version resolved in pnpm-lock.yaml.
//   - Runs inside the MSVC 14.44 x64 dev environment (vcvars64.bat) so INCLUDE
//     and LIB are always present even if node-gyp's vswhere auto-detection
//     regresses.
//   - node-gyp rebuild --target=<electron> --arch=x64
//     --dist-url=https://electronjs.org/headers downloads the Electron headers
//     into %LOCALAPPDATA%\node-gyp\Cache (first run only; proxied by policy).
//   - Deterministic staging path:
//     apps/desktop/native/windows/build/Release/hubfetch_job.node
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP = join(HERE, '..')
const ROOT = join(DESKTOP, '..', '..')
const NATIVE = join(DESKTOP, 'native', 'windows')

const ELECTRON_VERSION = '43.1.0'
const PINNED_NAPI_VERSION = '8.9.2'

function fail(message) {
  console.error(`[native-build] ERROR: ${message}`)
  process.exit(1)
}

if (process.platform !== 'win32') fail('hubfetch_job requires Windows (win32)')
if (process.arch !== 'x64') fail('hubfetch_job requires x64')

const napiPkgPath = join(ROOT, 'node_modules', 'node-addon-api', 'package.json')
if (!existsSync(napiPkgPath)) fail('node-addon-api not installed at the repo root node_modules')
const resolvedNapi = JSON.parse(readFileSync(napiPkgPath, 'utf8')).version
if (resolvedNapi !== PINNED_NAPI_VERSION) {
  fail(
    `node-addon-api resolved to ${resolvedNapi}, expected pinned ${PINNED_NAPI_VERSION} (pnpm-lock.yaml); run pnpm install`
  )
}

const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
const vswhere = join(programFilesX86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
if (!existsSync(vswhere)) fail(`vswhere not found at ${vswhere}; VS Build Tools required`)
const vsRes = spawnSync(
  vswhere,
  [
    '-latest',
    '-products',
    '*',
    '-requires',
    'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
    '-property',
    'installationPath'
  ],
  { encoding: 'utf8' }
)
if (vsRes.status !== 0) fail('vswhere could not locate a VS 2022 Build Tools installation')
const vsPath = (vsRes.stdout ?? '').trim()
const vcvars = join(vsPath, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat')
if (!existsSync(vcvars)) fail(`vcvars64.bat not found at ${vcvars}`)

const nodeGyp = join(ROOT, 'node_modules', '.bin', 'node-gyp.cmd')
if (!existsSync(nodeGyp)) fail(`node-gyp shim not found at ${nodeGyp}`)

// cmd /s (invoked by Node's shell:true wrapper) strips the outer quote pair, so
// the inner quoted paths survive. shell:true is required: spawning cmd.exe with
// the raw command string as an argv entry backslash-escapes the embedded quotes
// (\"...) which cmd.exe does not understand. This mirrors scripts/rebuild-native.mjs.
const command =
  `"${vcvars}" && "${nodeGyp}" rebuild --release --target=${ELECTRON_VERSION} ` +
  `--arch=x64 --dist-url=https://electronjs.org/headers`
const build = spawnSync(command, {
  cwd: NATIVE,
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, npm_config_msvs_version: '2022' }
})
if (build.status !== 0) process.exit(build.status ?? 1)

const staged = join(NATIVE, 'build', 'Release', 'hubfetch_job.node')
if (!existsSync(staged)) fail(`build reported success but ${staged} is missing`)
console.log(`[native-build] OK: ${staged}`)
