// apps/desktop/src/main/clone/matrix-fixtures.ts
//
// Todo 36: injectable fixture infrastructure for the deterministic
// clone/proxy/auth/cancellation/recovery integration matrix. Everything here is
// fully local (127.0.0.1 only) — no overseas network ever.
//
//   - fixture-git: a REAL Windows executable (`git.exe`) produced by compiling a
//     tiny C launcher that runs a behavior-driven `fixture-git.cjs` script with
//     `node`. The script is a spy (records argv/env) and can DELEGATE to real
//     system Git against a local smart-HTTP origin, COMPLETE deterministically
//     (emitting real progress stderr + a seeded `.git`), or FAIL with exact
//     stderr. This works because the clone envelope carries only `git[0]` and
//     `spawn()` (shell:false) cannot launch `.cmd` files on Windows.
//   - smart-HTTP origin: an in-process server proxying every request to real
//     `git http-backend`, serving bare repositories created with real Git.
//   - recording proxy trap: absolute-URI forwarding + CONNECT tunneling, with a
//     request log (the Direct-neutrality referee).
//   - Basic-auth origin: same origin behind `Authorization: Basic`.
//   - PAC fixture: a proxy auto-config script (for proxy policy evidence).
//   - sentinel / scan helpers: registered-secret leak detection across
//     buffers/files/directories.
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer, request as httpRequest, type Server } from 'node:http'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  type Stats
} from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { connect as tcpConnect, type AddressInfo } from 'node:net'
import { join } from 'node:path'

/** Real system Git (the delegating backend). */
export const REAL_GIT = 'C:\\Program Files\\Git\\cmd\\git.exe'

// ---------------------------------------------------------------------------
// Fixture-git executable (C launcher + behavior script)
// ---------------------------------------------------------------------------

/**
 * The compiled launcher: `git.exe` that runs `node "<dir>\fixture-git.cjs"`
 * with every argument forwarded, propagating the child exit code. This is the
 * ONLY way to get a real executable (spawn without a shell) whose behavior the
 * matrix controls.
 */
// The launcher derives the behavior script name from its OWN exe basename:
// `git.exe`            -> `git.cjs`            (Todo 36 fixture Git)
// `askpass-helper.exe` -> `askpass-helper.cjs` (Todo 36 GIT_ASKPASS fixture)
// `credential-helper.exe` -> `credential-helper.cjs` (Todo 36 system-auth fixture)
// One tiny C binary serves every fixture role; each fixture dir gets its own
// named exe + matching script.
const LAUNCHER_C = `
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>
#include <wchar.h>
#include <stdlib.h>

int wmain(void) {
    wchar_t self[MAX_PATH];
    DWORD len = GetModuleFileNameW(NULL, self, MAX_PATH);
    if (len == 0 || len >= MAX_PATH) return 2;
    wchar_t* slash = wcsrchr(self, L'\\\\');
    if (!slash) return 3;
    wchar_t* dot = wcsrchr(slash + 1, L'.');
    size_t dirLen = (size_t)(slash - self) + 1;
    size_t baseLen = dot ? (size_t)(dot - (slash + 1)) : wcslen(slash + 1);
    wchar_t script[MAX_PATH + 8];
    wcsncpy(script, self, dirLen);
    wcsncpy(script + dirLen, slash + 1, baseLen);
    script[dirLen + baseLen] = L'\\0';
    wcscat(script, L".cjs");
    int argc = 0;
    LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    size_t total = wcslen(L"node \\"\\"") + wcslen(script) + 8;
    for (int i = 1; i < argc; i++) total += wcslen(argv[i]) + 4;
    wchar_t* cmd = (wchar_t*)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, total * sizeof(wchar_t));
    if (!cmd) return 4;
    wcscpy(cmd, L"node \\"");
    wcscat(cmd, script);
    wcscat(cmd, L"\\"");
    for (int i = 1; i < argc; i++) {
        wcscat(cmd, L" \\"");
        wcscat(cmd, argv[i]);
        wcscat(cmd, L"\\"");
    }
    LocalFree(argv);
    STARTUPINFOW si = { sizeof(si) };
    PROCESS_INFORMATION pi = { 0 };
    if (!CreateProcessW(NULL, cmd, NULL, NULL, TRUE, 0, NULL, NULL, &si, &pi)) {
        HeapFree(GetProcessHeap(), 0, cmd);
        return 5;
    }
    HeapFree(GetProcessHeap(), 0, cmd);
    CloseHandle(pi.hThread);
    WaitForSingleObject(pi.hProcess, INFINITE);
    DWORD code = 1;
    GetExitCodeProcess(pi.hProcess, &code);
    CloseHandle(pi.hProcess);
    return (int)code;
}
`.trim()

const GCC_CANDIDATES = ['gcc', 'C:\\TDM-GCC-64\\bin\\gcc.exe', 'C:\\msys64\\mingw64\\bin\\gcc.exe']

/** Locate a usable gcc for the one-time launcher compile. */
function findGcc(): string | null {
  for (const candidate of GCC_CANDIDATES) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 15_000 })
    if (probe.status === 0 && !probe.error) return candidate
  }
  return null
}

let launcherCache: string | null = null

/**
 * Compile the fixture launcher once per vitest worker into a shared cache dir
 * under E:\Programs\Temp. Returns the compiled `git.exe` path.
 */
export function compileFixtureLauncher(): string {
  if (launcherCache !== null && existsSync(launcherCache)) return launcherCache
  const gcc = findGcc()
  if (gcc === null) {
    throw new Error(
      'Todo 36 matrix: no usable gcc found (required to compile the fixture-git launcher); ' +
        'candidates were: ' +
        GCC_CANDIDATES.join(', ')
    )
  }
  const cacheDir = join('E:\\Programs\\Temp', 'hubfetch-t36-fixture-cache')
  mkdirSync(cacheDir, { recursive: true })
  const source = join(cacheDir, 'fixture-git-launcher.c')
  const exe = join(cacheDir, 'fixture-git.exe')
  writeFileSync(source, LAUNCHER_C + '\n', 'utf8')
  const built = spawnSync(gcc, ['-O2', '-municode', '-o', exe, source, '-lshell32'], {
    encoding: 'utf8',
    timeout: 60_000
  })
  if (built.status !== 0 || !existsSync(exe)) {
    throw new Error(
      `Todo 36 matrix: fixture launcher compile failed (${built.status}): ${built.stderr ?? ''}`
    )
  }
  launcherCache = exe
  return exe
}

/**
 * Copy the compiled launcher into a fixture dir under `exeName` (e.g. `git.exe`
 * or `askpass-helper.exe`). The launcher runs `<exeName-without-.exe>.cjs` next
 * to itself, so each fixture role is one named exe + one behavior script.
 */
export function installFixtureExe(dir: string, exeName: string): string {
  const launcher = compileFixtureLauncher()
  const target = join(dir, exeName)
  const launcherStat = statSync(launcher)
  if (!existsSync(target) || statSync(target).size !== launcherStat.size) {
    writeFileSync(target, readFileSync(launcher))
  }
  return target
}

// ---------------------------------------------------------------------------
// Behavior scripts
// ---------------------------------------------------------------------------

/** Options embedded into one fixture-git script. */
export interface FixtureGitScriptOptions {
  /** Absolute JSONL log path the script appends every invocation to. */
  log: string
  /** Diagnostic probe responses (GitDiagnostics fixture). */
  probe: 'healthy'
  /** Clone behavior. */
  clone: FixtureCloneBehavior
}

export type FixtureCloneBehavior =
  | { action: 'complete'; progress?: string; seedMain?: string }
  | { action: 'fail'; stderr: string; exit: number; progress?: string }
  | { action: 'hang' }
  | {
      action: 'delegate'
      originUrl: string
      /** Extra env for the real-git child (e.g. GIT_CONFIG_GLOBAL). */
      env?: Record<string, string>
      /** Additional argv for the real-git child (after the mapped URL/dest). */
      extraArgv?: string[]
      /** Stderr injected BEFORE delegating (fragmented progress proof). */
      progress?: string
    }

/**
 * Map a derived clone URL (`https://huggingface.co/...` or `git@hf.co:...`) to
 * the local origin path: strip the host, append `.git`, prefix the origin URL.
 */
export function mapDerivedUrlToOrigin(url: string, originUrl: string): string {
  let suffix: string
  if (url.startsWith('https://')) {
    suffix = url.slice('https://huggingface.co'.length)
  } else if (url.startsWith('git@hf.co:')) {
    suffix = url.slice('git@hf.co:'.length)
  } else {
    suffix = url
  }
  if (suffix.startsWith('/')) suffix = suffix.slice(1)
  const trimmed = suffix.replace(/\.git$/, '')
  return `${originUrl}/${trimmed}.git`
}

/**
 * The fixture-git script body. A spy (every invocation is logged with argv +
 * selected env) that answers GitDiagnostics probes, then either delegates to
 * real Git against the local origin, completes deterministically, hangs, or
 * fails with exact stderr.
 */
export function fixtureGitScript(options: FixtureGitScriptOptions): string {
  const { log, clone } = options
  const behaviorJson = JSON.stringify({ clone })
  const logJson = JSON.stringify(log)
  const gitJson = JSON.stringify(REAL_GIT)
  return `'use strict'
// Todo 36 fixture Git: spy + deterministic delegate/complete/fail executable.
const fs = require('node:fs')
const { spawnSync, spawn } = require('node:child_process')
const LOG = ${logJson}
const BEHAVIOR = ${behaviorJson}
const GIT = ${gitJson}

function log(entry) {
  try {
    fs.appendFileSync(LOG, JSON.stringify(entry) + '\\n')
  } catch {}
}

const args = process.argv.slice(2)
log({ kind: 'invoke', argv: args, env: pickEnv() })
function pickEnv() {
  const keys = ['GIT_ASKPASS', 'HUBFETCH_ASKPASS_PIPE', 'GIT_TERMINAL_PROMPT', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NO_PROXY', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'LC_ALL', 'GIT_PROGRESS_DELAY']
  const out = {}
  for (const k of keys) {
    const v = process.env[k]
    if (v !== undefined) out[k] = v
  }
  return out
}

// The manager may prepend proxy/credential '-c <key> <value>' triples (Todo 20
// contract) BEFORE the subcommand. They are logged with the full argv above and
// stripped here so the fixture can find the clone/probe subcommand.
function stripConfigArgs(argv) {
  const out = []
  let i = 0
  while (i < argv.length) {
    if (argv[i] === '-c' && i + 1 < argv.length) {
      log({ kind: 'config-arg', key: argv[i + 1] })
      i += 2
      continue
    }
    out.push(argv[i])
    i += 1
  }
  return out
}
const stripped = stripConfigArgs(args)

const sub = stripped[0]
if (sub === '--version') {
  process.stdout.write('git version 2.47.0.windows.1\\n')
  process.exit(0)
}
if (sub === 'xet') {
  if (args[1] === 'version' || args[1] === '--version') {
    process.stdout.write('git-xet version 0.14.0\\n')
    process.exit(0)
  }
  process.stderr.write('fatal: unknown xet subcommand\\n')
  process.exit(1)
}
if (sub === 'config') {
  if (args.includes('--get-regexp')) {
    process.stdout.write('file:E:/fixture/.gitconfig\\tfilter.xet.process\\tgit-xet filter --smudge %f\\n')
    process.stdout.write('file:E:/fixture/.gitconfig\\tfilter.xet.required\\ttrue\\n')
    process.exit(0)
  }
  if (args.includes('--get-all')) {
    process.stdout.write('file:E:/fixture/.gitconfig\\tmanager\\n')
    process.exit(0)
  }
  process.stderr.write('fatal: unexpected config arguments\\n')
  process.exit(1)
}
if (sub === 'credential-manager' && args[1] === 'version') {
  process.stdout.write('Git Credential Manager version 2.5.1 (Windows, .NET 8.0.10)\\n')
  process.exit(0)
}

function seedGit(dest, seedMain) {
  try {
    fs.mkdirSync(dest + '/.git/refs/heads', { recursive: true })
    fs.mkdirSync(dest + '/.git/refs/remotes/origin', { recursive: true })
    fs.mkdirSync(dest + '/.git/refs/tags', { recursive: true })
    fs.writeFileSync(dest + '/.git/HEAD', 'ref: refs/heads/main\\n')
    const sha = seedMain || 'a'.repeat(40)
    fs.writeFileSync(dest + '/.git/refs/heads/main', sha + '\\n')
  } catch (e) {
    log({ kind: 'seed-error', message: String(e && e.message || e) })
  }
}

if (sub === 'clone') {
  // Runtime behavior override (env FIXTURE_BEHAVIOR_OVERRIDE -> a JSON file
  // whose 'clone' object replaces the embedded one). Lets one fixture exe serve
  // a failing first attempt and a succeeding retry / a hung crash victim and a
  // completing follower, like the real app would across attempts.
  let behavior = BEHAVIOR.clone || { action: 'complete' }
  const overrideFile = process.env.FIXTURE_BEHAVIOR_OVERRIDE
  if (overrideFile) {
    try {
      const parsed = JSON.parse(fs.readFileSync(overrideFile, 'utf8'))
      if (parsed && typeof parsed === 'object' && parsed.clone) behavior = parsed.clone
      log({ kind: 'behavior-override', file: overrideFile })
    } catch {
      log({ kind: 'behavior-override-error' })
    }
  }
  // Adversarial hooks (QA-failure scenarios only):
  // FIXTURE_LEAK_TOKEN -> the fixture deliberately writes the token into its
  // spy log so the sentinel scan can prove a leak is DETECTED.
  if (process.env.FIXTURE_LEAK_TOKEN) {
    log({ kind: 'leak', token: process.env.FIXTURE_LEAK_TOKEN })
  }
  // FIXTURE_SPAWN_GRANDCHILD -> the fixture spawns a DETACHED grandchild that
  // escapes the Job (Windows CREATE_NEW_PROCESS_GROUP) and records its pid, so
  // the zero-survivor check can prove an untracked survivor is DETECTED.
  if (process.env.FIXTURE_SPAWN_GRANDCHILD) {
    try {
      const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        detached: true,
        stdio: 'ignore'
      })
      const pidFile = process.env.FIXTURE_GRANDCHILD_PID_FILE
      if (pidFile && grandchild.pid) fs.writeFileSync(pidFile, String(grandchild.pid), 'utf8')
      log({ kind: 'grandchild-spawned', pid: grandchild.pid })
    } catch (e) {
      log({ kind: 'grandchild-error', message: String(e && e.message || e) })
    }
  }
  const dest = stripped[stripped.length - 1]
  if (behavior.action === 'fail') {
    if (behavior.progress) process.stderr.write(behavior.progress)
    process.stderr.write(behavior.stderr)
    process.exit(behavior.exit)
  }
  if (behavior.action === 'hang') {
    log({ kind: 'clone-hang' })
    // Bounded hang so a leaked worker can never block the suite forever.
    const timer = setInterval(() => {}, 1000)
    setTimeout(() => { clearInterval(timer); process.exit(0) }, 120000)
    return
  }
  if (behavior.action === 'complete') {
    log({ kind: 'clone-complete' })
    if (behavior.progress) process.stderr.write(behavior.progress)
    seedGit(dest, behavior.seedMain)
    process.exit(0)
  }
  if (behavior.action === 'delegate') {
    const url = stripped[stripped.length - 2]
    const mapped = mapUrl(url, behavior.originUrl)
    log({ kind: 'clone-delegate', originalUrl: url, mapped })
    if (behavior.progress) process.stderr.write(behavior.progress)
    // Forward the ORIGINAL argv (proxy/credential '-c' flags stay in place —
    // that is how Manual/Direct routing is proven) with only the URL + dest
    // swapped for the local origin. Extra '-c' flags are inserted BEFORE the
    // 'clone' subcommand so git's global-option parser always sees them first.
    const childEnv = Object.assign({}, process.env, { NO_PROXY: '', no_proxy: '' }, behavior.env || {})
    const cloneIndex = args.indexOf('clone')
    const prefix = cloneIndex === -1 ? [] : args.slice(0, cloneIndex)
    const suffix = cloneIndex === -1 ? args.slice(0, -2) : args.slice(cloneIndex, -2)
    const childArgv = prefix.concat(behavior.extraArgv || []).concat(suffix).concat([mapped, dest])
    log({ kind: 'delegate-argv', argv: childArgv })
    const child = spawn(GIT, childArgv, {
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let errTail = ''
    child.stdout.on('data', (d) => { process.stdout.write(d) })
    child.stderr.on('data', (d) => { errTail = (errTail + d.toString()).slice(-2000); process.stderr.write(d) })
    child.on('error', (e) => { log({ kind: 'delegate-error', message: String(e.message) }); process.exit(127) })
    child.on('close', (code) => {
      log({ kind: 'delegate-exit', code, stderrTail: errTail })
      process.exit(code === null ? 128 : code)
    })
    return
  }
  process.stderr.write('fatal: unknown clone behavior ' + behavior.action + '\\n')
  process.exit(2)
}

function mapUrl(url, origin) {
  let suffix = url
  if (url.startsWith('https://')) suffix = url.slice('https://huggingface.co'.length)
  else if (url.startsWith('git@hf.co:')) suffix = url.slice('git@hf.co:'.length)
  if (suffix.startsWith('/')) suffix = suffix.slice(1)
  suffix = suffix.replace(/\\.git$/, '')
  return origin + '/' + suffix + '.git'
}

process.stderr.write('fatal: not a git command\\n')
process.exit(1)
`
}

/** Write a behavior fixture-git into `dir`; returns the `git.exe` path. */
export function writeFixtureGit(dir: string, options: FixtureGitScriptOptions): string {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'git.cjs'), fixtureGitScript(options), 'utf8')
  return installFixtureExe(dir, 'git.exe')
}

/**
 * Write the fixture AskPass helper (`askpass-helper.exe` + `askpass-helper.cjs`).
 * Answers git's username/password prompts from the fixture token file. The
 * native AskPass server boundary is faked here; the contract env (GIT_ASKPASS,
 * HUBFETCH_ASKPASS_PIPE, credential-helper clearing) and the helper invocation
 * path are real.
 */
export function writeAskPassHelper(dir: string): string {
  mkdirSync(dir, { recursive: true })
  const script = `'use strict'
// Todo 36 fixture AskPass helper: answers git's username/password prompts from
// the fixture token file.
const fs = require('node:fs')
const prompt = process.argv[2] || ''
const log = process.env.FIXTURE_ASKPASS_LOG || ''
const tokenFile = process.env.FIXTURE_ASKPASS_TOKEN_FILE || ''
if (log) {
  try { fs.appendFileSync(log, 'ASKPASS prompt=' + JSON.stringify(prompt) + '\\n') } catch {}
}
if (!tokenFile || !fs.existsSync(tokenFile)) process.exit(1)
const token = fs.readFileSync(tokenFile, 'utf8').trim()
if (/[Uu]sername/.test(prompt)) process.stdout.write('hf_user\\n')
else process.stdout.write(token + '\\n')
`
  writeFileSync(join(dir, 'askpass-helper.cjs'), script, 'utf8')
  return installFixtureExe(dir, 'askpass-helper.exe')
}

/**
 * Write the fixture system credential helper (`credential-helper.exe` +
 * `credential-helper.cjs`). Answers git's `credential.helper` `get` operation
 * from the fixture token file (a real executable, so `-c credential.helper=`
 * works without a shell).
 */
export function writeCredentialHelper(dir: string): string {
  mkdirSync(dir, { recursive: true })
  const script = `'use strict'
// Todo 36 fixture "system" credential helper (GCM stand-in): answers the
// username/password get operation from the fixture token file.
const fs = require('node:fs')
const op = process.argv[2] || ''
if (op === 'get') {
  const tokenFile = process.env.FIXTURE_CRED_TOKEN_FILE || ''
  if (!tokenFile || !fs.existsSync(tokenFile)) process.exit(1)
  const token = fs.readFileSync(tokenFile, 'utf8').trim()
  process.stdout.write('username=hf_user\\n')
  process.stdout.write('password=' + token + '\\n')
}
`
  writeFileSync(join(dir, 'credential-helper.cjs'), script, 'utf8')
  return installFixtureExe(dir, 'credential-helper.exe')
}

// ---------------------------------------------------------------------------
// Bare repositories (real Git, local only)
// ---------------------------------------------------------------------------

export interface BareRepoInfo {
  /** Absolute path to the bare repo dir. */
  bareDir: string
  /** SHA-256 of the main branch tip (hex). */
  mainSha: string
  /** The derived-URL repo id, e.g. `qam/m1`. */
  repoId: string
}

/** Run real Git synchronously (bare-repo setup only, never while a server needs the loop). */
export function gitSync(
  args: string[],
  opts: { cwd: string }
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(REAL_GIT, args, {
    cwd: opts.cwd,
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true
  })
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function checkedGit(args: string[], opts: { cwd: string }, label: string): void {
  const result = gitSync(args, opts)
  if (result.status !== 0) {
    throw new Error(`git ${label} failed (${result.status}): ${result.stderr.slice(0, 500)}`)
  }
}

/**
 * Create bare repositories for the three repo kinds plus a seed commit, tag,
 * and extra branch. Returns kind-keyed repo info.
 */
export function makeOriginRepos(projectRoot: string): {
  projectRoot: string
  repos: Record<'model' | 'dataset' | 'space', BareRepoInfo>
} {
  mkdirSync(projectRoot, { recursive: true })
  const build = (kindPath: string, repoId: string): BareRepoInfo => {
    const seed = join(projectRoot, `seed-${repoId.replace(/\//g, '-')}`)
    const bareDir = join(projectRoot, kindPath, `${repoId.split('/').join('/')}.git`)
    mkdirSync(seed, { recursive: true })
    mkdirSync(join(seed, 'files'), { recursive: true })
    writeFileSync(join(seed, 'README.md'), `# ${repoId}\n`)
    writeFileSync(join(seed, 'data.bin'), Buffer.from(`binary-${repoId}`))
    for (let i = 0; i < 12; i++) {
      writeFileSync(join(seed, 'files', `file-${String(i).padStart(3, '0')}.txt`), `payload-${i}\n`)
    }
    checkedGit(['init', '-b', 'main'], { cwd: seed }, 'init')
    checkedGit(['config', 'user.email', 'qa@example.com'], { cwd: seed }, 'config email')
    checkedGit(['config', 'user.name', 'QA'], { cwd: seed }, 'config name')
    checkedGit(['add', '.'], { cwd: seed }, 'add')
    checkedGit(['commit', '-m', 'seed'], { cwd: seed }, 'commit')
    mkdirSync(join(projectRoot, kindPath), { recursive: true })
    checkedGit(['init', '--bare', bareDir], { cwd: projectRoot }, 'init --bare')
    checkedGit(['remote', 'add', 'origin', bareDir], { cwd: seed }, 'remote add')
    checkedGit(['push', 'origin', 'main'], { cwd: seed }, 'push')
    checkedGit(
      ['--git-dir', bareDir, 'symbolic-ref', 'HEAD', 'refs/heads/main'],
      { cwd: projectRoot },
      'HEAD'
    )
    checkedGit(['tag', 'v1.0.0'], { cwd: seed }, 'tag')
    checkedGit(['branch', 'feature-x'], { cwd: seed }, 'branch')
    checkedGit(['push', 'origin', 'v1.0.0', 'feature-x'], { cwd: seed }, 'push refs')
    const mainSha = gitSync(['--git-dir', bareDir, 'rev-parse', 'refs/heads/main'], {
      cwd: projectRoot
    }).stdout.trim()
    if (!/^[0-9a-f]{40}$/.test(mainSha)) {
      throw new Error(`repo ${repoId} main sha invalid: ${mainSha}`)
    }
    return { bareDir, mainSha, repoId }
  }
  const model = build('', 'qam/m1')
  const dataset = build('datasets', 'qam/d1')
  const space = build('spaces', 'qam/s1')
  return { projectRoot, repos: { model, dataset, space } }
}

// ---------------------------------------------------------------------------
// Smart-HTTP origin (real git http-backend in-process)
// ---------------------------------------------------------------------------

export interface RequestLog {
  method: string
  url: string
}

export interface SmartGitOrigin {
  /** Base URL, e.g. http://127.0.0.1:12345 */
  url: string
  requests: RequestLog[]
  /** Optional: assert the exact Basic header the fixture helper produced. */
  authLog: string[]
  close(): Promise<void>
}

export interface OriginOptions {
  projectRoot: string
  /** Optional Basic-auth gate: exact expected Authorization value. */
  expectedAuth?: string | null
  /** Optional gate failure body + status (e.g. 403 gated / 404). */
  gate?: { status: number; body: string } | null
}

function headersToEnv(req: { headers: NodeJS.Dict<string | string[]> }): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    env[`HTTP_${key.toUpperCase().replace(/-/g, '_')}`] = Array.isArray(value)
      ? value.join(', ')
      : String(value)
  }
  return env
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections?.()
    server.close(() => resolve())
  })
}

/**
 * In-process smart-HTTP Git origin: every request runs through real
 * `git http-backend` against `projectRoot`. Requests are async (git-backend is
 * spawned, never spawnSync) so the event loop keeps serving concurrent clones.
 */
export async function startSmartGitOrigin(options: OriginOptions): Promise<SmartGitOrigin> {
  const { projectRoot, expectedAuth = null, gate = null } = options
  const requests: RequestLog[] = []
  const authLog: string[] = []
  const server = createServer((req, res) => {
    requests.push({ method: req.method ?? '', url: req.url ?? '' })
    const authorization = req.headers.authorization ?? ''
    authLog.push(authorization || '<none>')
    if (expectedAuth !== null && authorization !== expectedAuth) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="hf"' })
      res.end('unauthorized')
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (gate !== null) {
      res.writeHead(gate.status, { 'Content-Type': 'text/plain' })
      res.end(gate.body)
      return
    }
    const child = spawn(REAL_GIT, ['http-backend'], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: projectRoot,
        PATH_INFO: url.pathname,
        QUERY_STRING: url.searchParams.toString(),
        REQUEST_METHOD: req.method ?? 'GET',
        CONTENT_TYPE: req.headers['content-type'] ?? '',
        CONTENT_LENGTH: req.headers['content-length'] ?? '0',
        REMOTE_USER: 'hf_user',
        GIT_HTTP_EXPORT_ALL: '1',
        ...headersToEnv(req)
      },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let out = Buffer.alloc(0)
    let err = ''
    child.stdout.on('data', (d) => {
      out = Buffer.concat([out, d])
    })
    child.stderr.on('data', (d) => {
      err += d.toString()
    })
    req.on('data', (d) => child.stdin.write(d))
    req.on('end', () => child.stdin.end())
    child.on('error', (e) => {
      res.writeHead(500, { 'Content-Type': 'text/plain' })
      res.end(`http-backend spawn failed: ${e.message}`)
    })
    child.on('exit', (code) => {
      const headerEnd = out.indexOf('\r\n\r\n')
      if (headerEnd === -1) {
        res.writeHead(code === 0 ? 200 : 500, { 'Content-Type': 'text/plain' })
        res.end(err || out.toString() || 'no backend output')
        return
      }
      const headerText = out.slice(0, headerEnd).toString('utf8')
      const body = out.slice(headerEnd + 4)
      const lines = headerText.split('\r\n')
      const statusMatch = /HTTP\/1\.[01] (\d{3})/.exec(lines[0] ?? '')
      const status = statusMatch ? Number(statusMatch[1]) : code === 0 ? 200 : 500
      const headers: Record<string, string> = {}
      for (let i = 1; i < lines.length; i++) {
        const idx = (lines[i] ?? '').indexOf(':')
        if (idx > 0)
          headers[(lines[i] ?? '').slice(0, idx).trim()] = (lines[i] ?? '').slice(idx + 1).trim()
      }
      res.writeHead(status, headers)
      res.end(body)
    })
  })
  await listen(server)
  const address = server.address() as AddressInfo
  const url = `http://127.0.0.1:${address.port}`
  return {
    url,
    requests,
    authLog,
    close: () => closeServer(server)
  }
}

// ---------------------------------------------------------------------------
// Recording proxy trap
// ---------------------------------------------------------------------------

export interface RecordingProxy {
  url: string
  requests: RequestLog[]
  close(): Promise<void>
}

/**
 * Recording forward proxy handling both absolute-URI forwarding (http) and
 * CONNECT tunnels. The Direct-neutrality referee: Direct clones must leave
 * `requests` empty even when proxy env/config points here.
 */
export async function startRecordingProxy(): Promise<RecordingProxy> {
  const requests: RequestLog[] = []
  const server = createServer((req, res) => {
    requests.push({ method: req.method ?? '', url: req.url ?? '' })
    let target: URL
    try {
      target = new URL(req.url ?? '')
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain' })
      res.end('bad proxy request line')
      return
    }
    const fwd = httpRequest(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: req.method,
        headers: { ...req.headers, host: target.host }
      },
      (fwdRes) => {
        res.writeHead(fwdRes.statusCode ?? 502, fwdRes.headers)
        fwdRes.pipe(res)
      }
    )
    fwd.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' })
      }
      res.end('proxy forward failed')
    })
    req.pipe(fwd)
  })

  server.on('connect', (req, clientSocket, head) => {
    requests.push({ method: 'CONNECT', url: req.url ?? '' })
    let target: URL
    try {
      target = new URL(`http://${req.url ?? ''}`)
    } catch {
      clientSocket.destroy()
      return
    }
    const upstream = tcpConnect(Number(target.port) || 80, target.hostname, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head && head.length > 0) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
    upstream.on('error', () => clientSocket.destroy())
    clientSocket.on('error', () => upstream.destroy())
  })

  await listen(server)
  const address = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${address.port}`, requests, close: () => closeServer(server) }
}

// ---------------------------------------------------------------------------
// PAC fixture
// ---------------------------------------------------------------------------

/** Write a PAC script fixture (Direct must never consult it). */
export function writePacFixture(dir: string): string {
  mkdirSync(dir, { recursive: true })
  const pac = `function FindProxyForURL(url, host) {
  if (host === 'huggingface.co' || host === 'hf.co') return 'PROXY 127.0.0.1:9; DIRECT';
  return 'DIRECT';
}
`
  const file = join(dir, 'fixture.pac')
  writeFileSync(file, pac, 'utf8')
  return file
}

// ---------------------------------------------------------------------------
// Sentinels + scanning
// ---------------------------------------------------------------------------

/** Deterministic-random sentinel (never a real credential pattern). */
export function randomSentinel(prefix = 't36-sentinel-'): string {
  return `${prefix}${randomBytes(12).toString('hex')}`
}

export function containsSentinel(data: Buffer | string, sentinel: string): boolean {
  return Buffer.isBuffer(data)
    ? data.includes(Buffer.from(sentinel, 'utf8'))
    : data.includes(sentinel)
}

function walk(dir: string, files: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const info: Stats = statSync(full)
    if (info.isDirectory()) walk(full, files)
    else files.push(full)
  }
}

/** Recursively scan a directory's bytes for the sentinel. */
export function scanDirForSentinel(
  dir: string,
  sentinel: string
): { found: boolean; files: string[] } {
  const hits: string[] = []
  if (!existsSync(dir)) return { found: false, files: hits }
  const files: string[] = []
  walk(dir, files)
  for (const file of files) {
    try {
      const data = readFileSync(file)
      if (containsSentinel(data, sentinel)) hits.push(file)
    } catch {
      /* unreadable file skipped */
    }
  }
  return { found: hits.length > 0, files: hits }
}

/** Async git for use while the in-process servers need the event loop. */
export function runGitAsync(
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(REAL_GIT, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: opts.timeoutMs ?? 60_000
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => {
      stdout += d.toString()
    })
    child.stderr.on('data', (d) => {
      stderr += d.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ status: code, stdout, stderr }))
  })
}

// ---------------------------------------------------------------------------
// Adversarial detectors (Todo 36 QA-failure invariants)
// ---------------------------------------------------------------------------

/** True when a Windows PID is still alive (signal 0 probe; ESRCH = dead). */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/** Zero-survivor check: returns the pids still alive (empty = zero-survivor). */
export function checkZeroSurvivors(pids: readonly number[]): number[] {
  return pids.filter((pid) => isPidAlive(pid))
}

/**
 * Direct-neutrality referee: a Direct-mode clone must NEVER leave a request on
 * the recording proxy trap. Returns the violating requests (empty = neutral).
 */
export function checkDirectNeutrality(proxyRequests: readonly RequestLog[]): readonly RequestLog[] {
  return proxyRequests
}

/**
 * Sentinel-leak check across arbitrary buffers/strings/files/directories.
 * Returns the human-readable hit list (empty = no leak).
 */
export function scanTargetsForSentinel(
  targets: ReadonlyArray<{
    label: string
    value: Buffer | string | { path: string }
  }>,
  sentinel: string
): string[] {
  const hits: string[] = []
  for (const target of targets) {
    const value = target.value
    if (typeof value === 'object' && 'path' in value) {
      const scanned = scanDirForSentinel(value.path, sentinel)
      for (const file of scanned.files) hits.push(`${target.label}:${file}`)
      continue
    }
    if (containsSentinel(value, sentinel)) hits.push(target.label)
  }
  return hits
}

// ---------------------------------------------------------------------------
// Evidence helpers
// ---------------------------------------------------------------------------

/** mkdtemp under E:\Programs\Temp (never C:\Users temp). */
export function makeScratchRoot(prefix: string): string {
  const base = 'E:\\Programs\\Temp'
  mkdirSync(base, { recursive: true })
  const dir = join(base, `${prefix}-${Date.now()}-${randomUUID().slice(0, 8)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

export async function writeJsonFile(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}
