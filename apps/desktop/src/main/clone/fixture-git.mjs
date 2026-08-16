// apps/desktop/src/main/clone/fixture-git.mjs
//
// Todo 29 test/QA fixture Git driver. A scriptable `git` stand-in that makes
// REAL local clones via a tiny in-memory fake working tree, emits configurable
// (possibly fragmented) stderr, supports the contract's fetch/checkout/rev-parse
// verbs, and records behavior via a JSON behavior file.
//
// Usage:  node fixture-git.mjs <behavior.json> [git argv...]
//
// The behavior JSON shape:
// {
//   "realCloneSource": "/local/barerepo.git" | undefined,  // when set, clone/fetch/
//                                                          // checkout/rev-parse run REAL git
//   "cloneStderr":  "Receiving objects: 100% (3/3), done.\n...",   // stderr emitted first on clone
//   "cloneExit":    0,                                             // clone exit code
//   "fetchStderr":  "", "fetchExit": 0,
//   "checkoutStderr": "", "checkoutExit": 0,
//   "revParseHead": "a1b2...",                                     // .git refs/heads/main sha
//   "refs": { "refs/remotes/origin/main": "a1b2..." },             // extra refs for rev-parse
//   "failOn": null,                                                // 'clone' | 'fetch' | 'checkout'
//   "errorStderr": "fatal: ...",                                   // emitted when failing
//   "makePartial": false                                           // write a partial file then fail
// }
//
// The URL passed to `clone` is never contacted (local only — proxy-safe).
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const behaviorPath = process.argv[2]
const args = process.argv.slice(3)
if (!behaviorPath) {
  process.stderr.write('fixture-git: missing behavior file\n')
  process.exit(2)
}
/** @type {any} */
const behavior = JSON.parse(readFileSync(behaviorPath, 'utf8'))

function writeErr(text) {
  if (text) process.stderr.write(text)
}

/** Run real system git, forwarding stdout/stderr; returns its exit status. */
function runRealGit(argv, cwd) {
  const res = spawnSync('git', argv, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  if (res.stdout) process.stdout.write(res.stdout)
  if (res.stderr) process.stderr.write(res.stderr)
  if (res.error) return 127
  return res.status ?? 0
}

/** Create a fake `.git` in a destination so rev-parse works afterwards. */
function seedGit(dest) {
  mkdirSync(join(dest, '.git', 'refs', 'heads'), { recursive: true })
  mkdirSync(join(dest, '.git', 'refs', 'remotes', 'origin'), { recursive: true })
  mkdirSync(join(dest, '.git', 'refs', 'tags'), { recursive: true })
  writeFileSync(join(dest, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  writeFileSync(
    join(dest, '.git', 'refs', 'heads', 'main'),
    `${behavior.revParseHead ?? 'a'.repeat(40)}\n`
  )
  if (behavior.refs) {
    for (const [ref, sha] of Object.entries(behavior.refs)) {
      const segments = ref.split('/')
      const leaf = segments[segments.length - 1]
      const dir = segments.slice(0, -1)
      mkdirSync(join(dest, '.git', ...dir), { recursive: true })
      writeFileSync(join(dest, '.git', ...dir, leaf), `${sha}\n`)
    }
  }
}

/** Resolve HEAD (possibly a symbolic ref) from the destination's fake .git. */
function resolveHead(dest) {
  const headFile = join(dest, '.git', 'HEAD')
  let head = readFileSync(headFile, 'utf8').trim()
  if (head.startsWith('ref: ')) {
    head = readFileSync(join(dest, '.git', head.slice(5).trim()), 'utf8').trim()
  }
  return head
}

if (args[0] === 'clone') {
  const dest = args[args.length - 1]
  const flags = args.slice(1, args.length - 2)
  if (behavior.makePartial) {
    mkdirSync(dest, { recursive: true })
    writeFileSync(join(dest, 'partial-file.txt'), 'partial')
  }
  if (behavior.failOn === 'clone') {
    writeErr(behavior.errorStderr ?? 'fatal: fixture clone failure\n')
    process.exit(behavior.cloneExit ?? 128)
  }
  // Emit the (possibly fragmented) progress stderr first, then either a REAL
  // local clone (from behavior.realCloneSource) or the fake seed.
  writeErr(behavior.cloneStderr ?? '')
  if (behavior.realCloneSource) {
    process.exit(runRealGit(['clone', ...flags, behavior.realCloneSource, dest], process.cwd()))
  }
  seedGit(dest)
  process.exit(behavior.cloneExit ?? 0)
}

if (args[0] === '-C') {
  const dest = args[1]
  const verb = args[2]
  // Real-clone mode: forward fetch/checkout/rev-parse to real git.
  if (behavior.realCloneSource) {
    if (verb === 'fetch' && behavior.failOn === 'fetch') {
      writeErr(behavior.errorStderr ?? 'fatal: fixture fetch failure\n')
      process.exit(behavior.fetchExit ?? 128)
    }
    if (verb === 'checkout' && behavior.failOn === 'checkout') {
      writeErr(behavior.errorStderr ?? 'fatal: fixture checkout failure\n')
      process.exit(behavior.checkoutExit ?? 128)
    }
    process.exit(runRealGit(args, process.cwd()))
  }
  if (verb === 'fetch') {
    if (behavior.failOn === 'fetch') {
      writeErr(behavior.errorStderr ?? 'fatal: fixture fetch failure\n')
      process.exit(behavior.fetchExit ?? 128)
    }
    writeErr(behavior.fetchStderr ?? '')
    process.exit(behavior.fetchExit ?? 0)
  }
  if (verb === 'checkout') {
    if (behavior.failOn === 'checkout') {
      writeErr(behavior.errorStderr ?? 'fatal: fixture checkout failure\n')
      process.exit(behavior.checkoutExit ?? 128)
    }
    // checkout --detach <sha>
    const sha = args[4]
    if (sha) writeFileSync(join(dest, '.git', 'HEAD'), `${sha}\n`)
    writeErr(behavior.checkoutStderr ?? '')
    process.exit(behavior.checkoutExit ?? 0)
  }
  if (verb === 'rev-parse') {
    const what = args[3]
    if (what === 'HEAD') {
      process.stdout.write(`${resolveHead(dest)}\n`)
      process.exit(0)
    }
    const sha = behavior.refs?.[what]
    if (sha) {
      process.stdout.write(`${sha}\n`)
      process.exit(0)
    }
    process.exit(128)
  }
}

// cwd-based rev-parse (runClone verifies with cwd = destination)
if (args[0] === 'rev-parse') {
  if (behavior.realCloneSource) {
    process.exit(runRealGit(args, process.cwd()))
  }
  const what = args[1]
  if (what === 'HEAD') {
    process.stdout.write(`${resolveHead(process.cwd())}\n`)
    process.exit(0)
  }
  const sha = behavior.refs?.[what]
  if (sha) {
    process.stdout.write(`${sha}\n`)
    process.exit(0)
  }
  process.exit(128)
}

process.stderr.write(`fixture-git: unrecognized argv ${JSON.stringify(args)}\n`)
process.exit(2)
