// apps/desktop/src/main/clone/clone-contract.test.ts
//
// Todo 29 table/property tests for the shell-free clone contracts:
//   - three repo kinds x two transports (URL derivation, credential absence)
//   - revision forms (branch/tag/commit) and exact argv
//   - injection / reserved-path rejection (ids, revisions, raw URLs)
//   - progress: documented phases, monotonic + clamped accumulation,
//     bounded unknown output with redaction
//   - typed errors: the full 10-code mapping table with sanitized detail
//   - destination: absent/empty validation + atomic reservation race
//   - final `git rev-parse HEAD` verification of the requested revision
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  cloneAuthModeSchema,
  cloneCommitShaSchema,
  cloneNamespaceNameSchema,
  cloneRepoKindSchema,
  cloneRequestSchema,
  cloneRevisionSchema,
  cloneTransportSchema,
  deriveCloneUrl,
  isDerivedCloneUrl,
  isValidCloneNamespaceName,
  type CloneRepoKind,
  type CloneRevision
} from '@hubfetch/shared'
import { Redactor } from '../security/redaction'
import {
  BoundedCloneDiagnostics,
  CLONE_ERROR_CODES,
  CloneExecutionError,
  CloneProgressAccumulator,
  DestinationError,
  MAX_DIAGNOSTIC_LINE_LENGTH,
  MAX_DIAGNOSTIC_LINES,
  buildCloneArgv,
  classifyCloneError,
  cloneEnvironment,
  makeCloneFailure,
  parseCloneProgressLine,
  parseCloneStderr,
  reserveCloneDestination,
  runClone,
  splitFragmentedLines,
  verifyCloneHead,
  type RunCloneOptions,
  type SpawnResult
} from './clone-contract'

const FIXTURE_GIT = fileURLToPath(new URL('./fixture-git.mjs', import.meta.url))
const HEAD_SHA = 'a'.repeat(40)
const OTHER_SHA = 'b'.repeat(40)
const MODEL_URL = 'https://huggingface.co/author/model'
const SECRET = 'hf_test_secret_123'

const cleanupDirs: string[] = []
function scratch(prefix: string): string {
  // mkdtemp under os.tmpdir() (honors TMP/TEMP => E:\Programs\Temp here).
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanupDirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of cleanupDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

async function writeBehavior(dir: string, behavior: unknown): Promise<string> {
  const path = join(dir, 'behavior.json')
  await writeFile(path, JSON.stringify(behavior))
  return path
}

function gitPrefix(behaviorPath: string): string[] {
  return ['node', FIXTURE_GIT, behaviorPath]
}

/** Simulated git spawn that seeds a fake .git so real rev-parse works. */
function simulatedCloneSpawn(
  calls: string[][],
  options: {
    stderrByVerb?: Partial<Record<string, string>>
    checkoutWritesHead?: boolean
  } = {}
): (
  git: readonly string[],
  argv: readonly string[],
  env: Readonly<Record<string, string>>,
  timeout: number
) => SpawnResult {
  const { stderrByVerb = {}, checkoutWritesHead = true } = options
  return (_git, argv, _env, _timeout) => {
    calls.push([...argv])
    const verb = argv[0]
    if (verb === 'clone') {
      const dest = argv[argv.length - 1] ?? ''
      mkdirSyncTree(dest)
      writeFileSyncF(join(dest, '.git', 'HEAD'), 'ref: refs/heads/main\n')
      writeFileSyncF(join(dest, '.git', 'refs', 'heads', 'main'), `${HEAD_SHA}\n`)
      writeFileSyncF(join(dest, '.git', 'refs', 'remotes', 'origin', 'main'), `${HEAD_SHA}\n`)
      return { status: 0, stdout: '', stderr: stderrByVerb.clone ?? '', error: null }
    }
    if (verb === '-C') {
      const dest = argv[1] ?? ''
      const sub = argv[2]
      if (sub === 'fetch')
        return { status: 0, stdout: '', stderr: stderrByVerb.fetch ?? '', error: null }
      if (sub === 'checkout') {
        const sha = argv[4]
        if (checkoutWritesHead && sha !== undefined)
          writeFileSyncF(join(dest, '.git', 'HEAD'), `${sha}\n`)
        return { status: 0, stdout: '', stderr: stderrByVerb.checkout ?? '', error: null }
      }
    }
    return { status: 2, stdout: '', stderr: 'unexpected verb', error: null }
  }
}
function mkdirSyncTree(p: string): void {
  mkdirSync(p, { recursive: true })
  mkdirSync(join(p, '.git', 'refs', 'heads'), { recursive: true })
  mkdirSync(join(p, '.git', 'refs', 'remotes', 'origin'), { recursive: true })
}
function writeFileSyncF(p: string, content: string): void {
  writeFileSync(p, content)
}

// ---------------------------------------------------------------------------
// Shared schemas
// ---------------------------------------------------------------------------

describe('clone shared schemas', () => {
  it('closed repo kinds, transports, auth modes', () => {
    expect(cloneRepoKindSchema.options).toEqual(['model', 'dataset', 'space'])
    expect(cloneTransportSchema.options).toEqual(['https', 'ssh'])
    expect(cloneAuthModeSchema.options).toEqual(['none', 'app-token', 'system'])
  })

  it('request schema accepts a full valid request', () => {
    const parsed = cloneRequestSchema.safeParse({
      kind: 'model',
      id: 'author/model',
      revision: { kind: 'branch', name: 'main' },
      transport: 'https',
      destination: 'C:\\work\\model',
      auth: 'none'
    })
    expect(parsed.success).toBe(true)
  })

  it('request schema rejects unknown fields and bad kinds', () => {
    expect(
      cloneRequestSchema.safeParse({
        kind: 'model',
        id: 'author/model',
        transport: 'https',
        destination: 'C:\\d',
        auth: 'none',
        extra: 1
      }).success
    ).toBe(false)
    expect(
      cloneRequestSchema.safeParse({
        kind: 'kernel',
        id: 'a/b',
        transport: 'https',
        destination: 'x',
        auth: 'none'
      }).success
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Repository id validation (injection / reserved paths)
// ---------------------------------------------------------------------------

describe('strict namespace/name', () => {
  const validIds = ['author/model', 'a/b', 'A-B/C.D', 'org/repo_name', 'x/Y9', 'org/name-2']
  const invalidIds = [
    '',
    'model',
    'a b/c',
    'a@b/c',
    'a:b/c',
    '/a/b',
    'a/b/',
    '-x/y',
    '.hidden/x',
    'a/.',
    'a/..',
    '../x',
    'x/..',
    'a//b',
    'a\\b',
    'a/b c',
    ' a/b',
    'a/b ',
    'a/ b',
    'a /b',
    'a\nb/c',
    'a/b\t'
  ]

  it.each(validIds)('accepts %j', (id) => {
    expect(isValidCloneNamespaceName(id)).toBe(true)
    expect(cloneNamespaceNameSchema.safeParse(id).success).toBe(true)
  })

  it.each(invalidIds)('rejects %j', (id) => {
    expect(isValidCloneNamespaceName(id)).toBe(false)
    expect(cloneNamespaceNameSchema.safeParse(id).success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// URL derivation: three repo kinds x two transports, credential-free
// ---------------------------------------------------------------------------

describe('derived clone URLs', () => {
  const cases: Array<[string, string, string, string]> = [
    ['model', 'author/model', 'https', 'https://huggingface.co/author/model'],
    ['dataset', 'author/data', 'https', 'https://huggingface.co/datasets/author/data'],
    ['space', 'author/demo', 'https', 'https://huggingface.co/spaces/author/demo'],
    ['model', 'author/model', 'ssh', 'git@hf.co:author/model'],
    ['dataset', 'author/data', 'ssh', 'git@hf.co:datasets/author/data'],
    ['space', 'author/demo', 'ssh', 'git@hf.co:spaces/author/demo']
  ]

  it.each(cases)('%s %s %s -> %s', (kind, id, transport, expected) => {
    expect(deriveCloneUrl(kind as CloneRepoKind, id, transport as 'https' | 'ssh')).toBe(expected)
  })

  it('derived URLs never carry credentials, userinfo, or query', () => {
    for (const kind of ['model', 'dataset', 'space'] as const) {
      for (const transport of ['https', 'ssh'] as const) {
        const url = deriveCloneUrl(kind, 'author/model', transport)
        // No query, no password-bearing userinfo (git@ IS the SSH user prefix,
        // which carries no credential), no http userinfo.
        expect(url).not.toContain('?')
        expect(url).not.toMatch(/:[^/@\s]+@/)
        expect(url).not.toMatch(/\/\/[^@]*:[^@]*@/)
      }
    }
  })

  it('derivation rejects an invalid id before building a URL', () => {
    for (const kind of ['model', 'dataset', 'space'] as const) {
      expect(() => deriveCloneUrl(kind, '-x/y', 'https')).toThrow()
      expect(() => deriveCloneUrl(kind, 'author/model extra', 'ssh')).toThrow()
    }
  })

  it('isDerivedCloneUrl accepts only the derived shapes', () => {
    expect(isDerivedCloneUrl('https://huggingface.co/author/model')).toBe(true)
    expect(isDerivedCloneUrl('https://huggingface.co/datasets/author/data')).toBe(true)
    expect(isDerivedCloneUrl('git@hf.co:spaces/author/demo')).toBe(true)
    expect(isDerivedCloneUrl('https://example.com/author/model')).toBe(false)
    expect(isDerivedCloneUrl('https://user:pass@huggingface.co/author/model')).toBe(false)
    expect(isDerivedCloneUrl('git@github.com:author/model')).toBe(false)
    expect(isDerivedCloneUrl('')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// argv: exact, literal, no shell
// ---------------------------------------------------------------------------

describe('clone argv', () => {
  const dest = 'C:\\work\\model'

  it('no revision: clone --progress url dest', () => {
    expect(buildCloneArgv({ url: MODEL_URL, destination: dest })).toEqual([
      'clone',
      '--progress',
      MODEL_URL,
      dest
    ])
  })

  it('branch: --branch <ref> --single-branch', () => {
    expect(
      buildCloneArgv({
        url: MODEL_URL,
        destination: dest,
        revision: { kind: 'branch', name: 'main' }
      })
    ).toEqual(['clone', '--progress', '--branch', 'main', '--single-branch', MODEL_URL, dest])
  })

  it('tag: --branch <tag> --single-branch', () => {
    expect(
      buildCloneArgv({
        url: MODEL_URL,
        destination: dest,
        revision: { kind: 'tag', name: 'v1.0.0' }
      })
    ).toEqual(['clone', '--progress', '--branch', 'v1.0.0', '--single-branch', MODEL_URL, dest])
  })

  it('commit: --no-checkout (fetch + detached checkout happen later)', () => {
    expect(
      buildCloneArgv({
        url: MODEL_URL,
        destination: dest,
        revision: { kind: 'commit', sha: HEAD_SHA }
      })
    ).toEqual(['clone', '--progress', '--no-checkout', MODEL_URL, dest])
  })

  it('shell metacharacters in the destination survive as one literal token', () => {
    const evil = 'C:\\work\\dest & model; rm -rf'
    expect(buildCloneArgv({ url: MODEL_URL, destination: evil })).toEqual([
      'clone',
      '--progress',
      MODEL_URL,
      evil
    ])
  })

  it('proxy -c flags are prepended before the subcommand', () => {
    const proxy = {
      argv: ['-c', 'http.proxy=http://127.0.0.1:7897', '-c', 'https.proxy=http://127.0.0.1:7897'],
      env: {},
      label: 'manual' as const
    }
    expect(buildCloneArgv({ url: MODEL_URL, destination: dest, proxy })).toEqual([
      '-c',
      'http.proxy=http://127.0.0.1:7897',
      '-c',
      'https.proxy=http://127.0.0.1:7897',
      'clone',
      '--progress',
      MODEL_URL,
      dest
    ])
  })
})

describe('clone environment', () => {
  it('sets stable non-interactive git controls without mutating the parent', () => {
    const base = { PATH: 'C:\\bin', LANG: 'zh_CN.UTF-8' }
    const env = cloneEnvironment(base)
    expect(env.LC_ALL).toBe('C')
    expect(env.GIT_PROGRESS_DELAY).toBe('0')
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
    expect(env.PATH).toBe('C:\\bin')
    expect(base).toEqual({ PATH: 'C:\\bin', LANG: 'zh_CN.UTF-8' })
  })
})

// ---------------------------------------------------------------------------
// Revision validation
// ---------------------------------------------------------------------------

describe('clone revision schema', () => {
  it.each(['-evil', 'a b', 'a@b', 'a..b', 'a:b', 'a\tb', ''] as const)(
    'rejects branch %j',
    (name) => {
      expect(cloneRevisionSchema.safeParse({ kind: 'branch', name }).success).toBe(false)
    }
  )

  it.each(['feature/foo', 'main', 'release-1.0'] as const)(
    'accepts nested/plain branch %j',
    (name) => {
      expect(cloneRevisionSchema.safeParse({ kind: 'branch', name }).success).toBe(true)
    }
  )

  it('requires a full 40-hex commit sha', () => {
    expect(cloneCommitShaSchema.safeParse('abc').success).toBe(false)
    expect(cloneCommitShaSchema.safeParse('A'.repeat(40)).success).toBe(false)
    expect(cloneCommitShaSchema.safeParse(HEAD_SHA).success).toBe(true)
  })

  it('rejects a commit revision carrying option text', () => {
    expect(cloneRevisionSchema.safeParse({ kind: 'commit', sha: '--help' }).success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Progress parsing
// ---------------------------------------------------------------------------

describe('parseCloneProgressLine', () => {
  it('parses every documented phase', () => {
    expect(parseCloneProgressLine('remote: Enumerating objects: 42, done.')).toEqual({
      phase: 'enumerating',
      percent: 100,
      done: 42,
      total: 42
    })
    expect(parseCloneProgressLine('remote: Counting objects: 50% (3/6), done.')).toMatchObject({
      phase: 'counting',
      percent: 50,
      done: 3,
      total: 6
    })
    expect(parseCloneProgressLine('remote: Compressing objects: 100% (2/2), done.')).toMatchObject({
      phase: 'compressing',
      percent: 100,
      done: 2,
      total: 2
    })
    expect(
      parseCloneProgressLine('Receiving objects:  33% (1/3), 1.00 MiB | 512.00 KiB/s')
    ).toMatchObject({
      phase: 'receiving',
      percent: 33,
      done: 1,
      total: 3,
      rate: '1.00 MiB | 512.00 KiB/s'
    })
    expect(parseCloneProgressLine('Resolving deltas: 50% (1/2)')).toMatchObject({
      phase: 'resolving',
      percent: 50,
      done: 1,
      total: 2
    })
    expect(parseCloneProgressLine('Updating files: 100% (4/4), done.')).toMatchObject({
      phase: 'updating',
      percent: 100,
      done: 4,
      total: 4,
      rate: undefined
    })
    expect(parseCloneProgressLine('Checking out files: 50% (1/2)')).toMatchObject({
      phase: 'checkout',
      percent: 50,
      done: 1,
      total: 2
    })
    expect(parseCloneProgressLine('Downloading xet blobs: 50% (2/4), done.')).toMatchObject({
      phase: 'xet',
      percent: 50,
      done: 2,
      total: 4
    })
  })

  it('drops the trailing done marker from the rate', () => {
    expect(
      parseCloneProgressLine('Receiving objects: 100% (3/3), 1.10 MiB | 1.20 MiB/s, done.')?.rate
    ).toBe('1.10 MiB | 1.20 MiB/s')
  })

  it('rejects out-of-contract lines (unparseable, >100%, malformed counters)', () => {
    expect(parseCloneProgressLine('Receiving objects: 150% (3/3), done.')).toBeNull()
    expect(parseCloneProgressLine('Receiving objects: 100% (3/3) extra junk')).toBeNull()
    expect(parseCloneProgressLine("Cloning into 'dest'...")).toBeNull()
    expect(parseCloneProgressLine('remote: Total 3 (delta 0), reused 0 (delta 0)')).toBeNull()
    expect(parseCloneProgressLine('')).toBeNull()
  })
})

describe('CloneProgressAccumulator (monotonic + clamped)', () => {
  it('clamps percent to 0..100 and done to <= total', () => {
    const acc = new CloneProgressAccumulator()
    acc.update({ phase: 'receiving', percent: 130, done: 5, total: 4 })
    acc.update({ phase: 'receiving', percent: -10, done: -3, total: 4 })
    const records = acc.records()
    const last = records[records.length - 1]
    expect(last?.percent).toBe(100)
    // Monotonic within the phase: done never decreases even when a later
    // (clamped) update reports a smaller counter; total stays bounded.
    expect(last?.done).toBe(4)
    expect(last?.total).toBe(4)
  })

  it('keeps percent and done monotonic within a phase', () => {
    const acc = new CloneProgressAccumulator()
    acc.update({ phase: 'receiving', percent: 50, done: 2, total: 4 })
    acc.update({ phase: 'receiving', percent: 30, done: 1, total: 4 })
    expect(acc.phasePercent('receiving')).toBe(50)
    const last = acc.records()[acc.records().length - 1]
    expect(last).toMatchObject({ percent: 50, done: 2, total: 4 })
    acc.update({ phase: 'receiving', percent: 90, done: 3, total: 4 })
    expect(acc.phasePercent('receiving')).toBe(90)
  })

  it('a new phase resets its own progress', () => {
    const acc = new CloneProgressAccumulator()
    acc.update({ phase: 'receiving', percent: 100, done: 4, total: 4 })
    acc.update({ phase: 'updating', percent: 10, done: 1, total: 10 })
    expect(acc.phasePercent('receiving')).toBe(100)
    expect(acc.phasePercent('updating')).toBe(10)
    expect(acc.latest()?.phase).toBe('updating')
  })

  it('starts empty', () => {
    const acc = new CloneProgressAccumulator()
    expect(acc.latest()).toBeNull()
    expect(acc.records()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Bounded unknown output
// ---------------------------------------------------------------------------

describe('bounded clone diagnostics', () => {
  it('caps the number of retained unknown lines and counts drops', () => {
    const diag = new BoundedCloneDiagnostics()
    const redactor = new Redactor()
    for (let i = 0; i < MAX_DIAGNOSTIC_LINES + 10; i += 1) diag.add(`line ${i}`, redactor)
    expect(diag.snapshot().length).toBe(MAX_DIAGNOSTIC_LINES)
    expect(diag.dropped()).toBe(10)
  })

  it('truncates long lines to the contract bound', () => {
    const diag = new BoundedCloneDiagnostics()
    diag.add('x'.repeat(MAX_DIAGNOSTIC_LINE_LENGTH * 2), new Redactor())
    expect(diag.snapshot()[0]?.length).toBe(MAX_DIAGNOSTIC_LINE_LENGTH)
  })

  it('redacts secrets embedded in unknown lines', () => {
    const diag = new BoundedCloneDiagnostics()
    diag.add(
      `fatal: unable to access 'https://user:${SECRET}@huggingface.co': boom`,
      new Redactor()
    )
    const line = diag.snapshot()[0] ?? ''
    expect(line).toContain('[REDACTED]')
    expect(line).not.toContain(SECRET)
  })
})

describe('fragmented stderr splitting', () => {
  it("splits on \\r and \\n like git's carriage-return progress updates", () => {
    expect(
      splitFragmentedLines(
        'Receiving objects: 50% (1/2)\rReceiving objects: 100% (2/2), done.\nDone.'
      )
    ).toEqual(['Receiving objects: 50% (1/2)', 'Receiving objects: 100% (2/2), done.', 'Done.'])
  })

  it('parseCloneStderr separates records from bounded diagnostics', () => {
    const accumulator = new CloneProgressAccumulator()
    const diag = new BoundedCloneDiagnostics()
    const records = parseCloneStderr(
      "Cloning into 'dest'...\nReceiving objects: 100% (3/3), done.\nremote: Total 3 (delta 0), reused 0 (delta 0), pack-reused 0\n",
      { accumulator, diagnostics: diag, redactor: new Redactor() }
    )
    expect(records.map((r) => r.phase)).toEqual(['receiving'])
    expect(diag.snapshot().length).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

describe('error classification', () => {
  const cases: Array<[string, string]> = [
    ["fatal: Authentication failed for 'https://huggingface.co/author/model/'\n", 'auth'],
    ['fatal: could not read Username: terminal prompts disabled\n', 'auth'],
    [
      'remote: Access to repository author/repo is disabled.\nfatal: The requested URL returned error: 403\n',
      'gated'
    ],
    ["fatal: external filter 'git-xet filter' failed\n", 'dependency'],
    ["fatal: repository 'https://huggingface.co/x/y' not found\n", 'not-found'],
    [
      "fatal: unable to access 'https://huggingface.co/x/y': Could not resolve proxy: localhost\n",
      'proxy'
    ],
    [
      "fatal: unable to access 'https://huggingface.co/x/y': Failed to connect to huggingface.co port 443: Connection refused\n",
      'network'
    ],
    ["fatal: unable to create file 'C:/x/file': No space left on device\n", 'disk'],
    [
      "fatal: destination path 'C:/x' already exists and is not an empty directory\n",
      'destination'
    ],
    ['fatal: operation canceled\n', 'cancelled'],
    ['fatal: an unrecognized failure\n', 'internal']
  ]

  it.each(cases)('%j -> %s', (stderr, expected) => {
    expect(classifyCloneError(stderr.toLocaleLowerCase(), 128)).toBe(expected)
  })

  it('covers exactly the closed account-aware code set', () => {
    expect(CLONE_ERROR_CODES).toEqual([
      'dependency',
      'auth',
      'account-unavailable',
      'gated',
      'not-found',
      'network',
      'proxy',
      'disk',
      'destination',
      'cancelled',
      'internal'
    ])
  })

  it('makeCloneFailure preserves sanitized detail', () => {
    const failure = makeCloneFailure(
      128,
      "fatal: Authentication failed for 'https://huggingface.co/x/y/'\n",
      new Redactor()
    )
    expect(failure.code).toBe('auth')
    expect(failure.detail).toContain('Authentication failed')
    expect(failure.exitCode).toBe(128)
  })

  it('makeCloneFailure redacts secrets from the preserved detail', () => {
    const failure = makeCloneFailure(
      128,
      `fatal: unable to access 'https://user:${SECRET}@huggingface.co': Could not resolve host\n`,
      new Redactor()
    )
    expect(failure.code).toBe('network')
    expect(failure.detail).not.toContain(SECRET)
  })

  it('CloneExecutionError is the typed error with code + exitCode', () => {
    const error = new CloneExecutionError({ code: 'disk', detail: 'no space left', exitCode: 128 })
    expect(error).toBeInstanceOf(Error)
    expect(error.code).toBe('disk')
    expect(error.exitCode).toBe(128)
    expect(error.message).toContain('disk')
  })
})

// ---------------------------------------------------------------------------
// Destination reservation (absent/empty, atomic race, never destructive)
// ---------------------------------------------------------------------------

describe('destination reservation', () => {
  it('creates an absent destination and reserves it atomically', async () => {
    const root = scratch('t29-res-')
    const dest = join(root, 'dest')
    const reservation = await reserveCloneDestination(dest)
    expect(reservation.status).toBe('created')
    await reservation.release()
    await expect(reserveCloneDestination(dest)).resolves.toMatchObject({ status: 'reserved' })
  })

  it('exactly one concurrent reservation wins on the same path', async () => {
    const root = scratch('t29-race-')
    const dest = join(root, 'race')
    const results = await Promise.allSettled([
      reserveCloneDestination(dest),
      reserveCloneDestination(dest)
    ])
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(fulfilled.length).toBe(1)
    expect(rejected.length).toBe(1)
    if (fulfilled[0]?.status === 'fulfilled') await fulfilled[0].value.release()
  })

  it('a held empty destination refuses a second reservation', async () => {
    const root = scratch('t29-held-')
    const dest = join(root, 'held')
    await mkdir(dest)
    const first = await reserveCloneDestination(dest)
    expect(first.status).toBe('reserved')
    await expect(reserveCloneDestination(dest)).rejects.toBeInstanceOf(DestinationError)
    await first.release()
    await expect(reserveCloneDestination(dest)).resolves.toMatchObject({ status: 'reserved' })
  })

  it('refuses a non-empty directory without touching it', async () => {
    const root = scratch('t29-nonempty-')
    const dest = join(root, 'dest')
    await mkdir(dest)
    await writeFile(join(dest, 'existing.txt'), 'x')
    await expect(reserveCloneDestination(dest)).rejects.toBeInstanceOf(DestinationError)
    expect(await readdirLen(dest)).toBe(1)
  })

  it('refuses a destination that is a file', async () => {
    const root = scratch('t29-file-')
    const dest = join(root, 'dest')
    await writeFile(dest, 'x')
    await expect(reserveCloneDestination(dest)).rejects.toBeInstanceOf(DestinationError)
  })

  it('refuses an uncreatable destination', async () => {
    const root = scratch('t29-noparent-')
    await expect(
      reserveCloneDestination(join(root, 'no-such-parent', 'dest'))
    ).rejects.toBeInstanceOf(DestinationError)
  })
})

async function readdirLen(dir: string): Promise<number> {
  const { readdir } = await import('node:fs/promises')
  return (await readdir(dir)).length
}

// ---------------------------------------------------------------------------
// HEAD verification
// ---------------------------------------------------------------------------

async function seedFakeGit(dir: string, headSha: string): Promise<void> {
  await mkdir(join(dir, '.git', 'refs', 'heads'), { recursive: true })
  await mkdir(join(dir, '.git', 'refs', 'remotes', 'origin'), { recursive: true })
  await writeFile(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  await writeFile(join(dir, '.git', 'refs', 'heads', 'main'), `${headSha}\n`)
  await writeFile(join(dir, '.git', 'refs', 'remotes', 'origin', 'main'), `${headSha}\n`)
  await writeFile(
    join(dir, '.git', 'config'),
    '[core]\n\trepositoryformatversion = 0\n\tfilemode = false\n'
  )
}

describe('verifyCloneHead', () => {
  const git = ['node', FIXTURE_GIT, ''] as string[]

  it('fails when the destination has no .git', async () => {
    const dir = scratch('t29-head-')
    const verification = await verifyCloneHead(join(dir, 'none'), undefined, { git })
    expect(verification.ok).toBe(false)
    expect(verification.detail).toContain('.git')
  })

  it('verifies HEAD for a revision-less clone', async () => {
    const dir = scratch('t29-head-')
    await seedFakeGit(dir, HEAD_SHA)
    const behaviorPath = await writeBehavior(dir, { revParseHead: HEAD_SHA })
    const verification = await verifyCloneHead(dir, undefined, { git: gitPrefix(behaviorPath) })
    expect(verification.ok).toBe(true)
    expect(verification.sha).toBe(HEAD_SHA)
  })

  it('verifies a branch clone against its origin tip', async () => {
    const dir = scratch('t29-head-')
    await seedFakeGit(dir, HEAD_SHA)
    const behaviorPath = await writeBehavior(dir, {
      revParseHead: HEAD_SHA,
      refs: { 'refs/remotes/origin/main': HEAD_SHA }
    })
    const verification = await verifyCloneHead(
      dir,
      { kind: 'branch', name: 'main' },
      { git: gitPrefix(behaviorPath) }
    )
    expect(verification.ok).toBe(true)
    expect(verification.expected).toBe(HEAD_SHA)
  })

  it('fails a branch clone whose tip disagrees with HEAD', async () => {
    const dir = scratch('t29-head-')
    await seedFakeGit(dir, HEAD_SHA)
    const behaviorPath = await writeBehavior(dir, {
      revParseHead: HEAD_SHA,
      refs: { 'refs/remotes/origin/main': OTHER_SHA }
    })
    const verification = await verifyCloneHead(
      dir,
      { kind: 'branch', name: 'main' },
      { git: gitPrefix(behaviorPath) }
    )
    expect(verification.ok).toBe(false)
    expect(verification.expected).toBe(OTHER_SHA)
  })

  it('verifies a commit clone against the requested sha', async () => {
    const dir = scratch('t29-head-')
    await mkdir(join(dir, '.git'), { recursive: true })
    await writeFile(join(dir, '.git', 'HEAD'), `${HEAD_SHA}\n`)
    const behaviorPath = await writeBehavior(dir, { revParseHead: HEAD_SHA })
    const verification = await verifyCloneHead(
      dir,
      { kind: 'commit', sha: HEAD_SHA },
      { git: gitPrefix(behaviorPath) }
    )
    expect(verification.ok).toBe(true)
    expect(verification.sha).toBe(HEAD_SHA)
  })

  it('fails a commit clone whose HEAD disagrees with the requested sha', async () => {
    const dir = scratch('t29-head-')
    await mkdir(join(dir, '.git'), { recursive: true })
    await writeFile(join(dir, '.git', 'HEAD'), `${HEAD_SHA}\n`)
    const behaviorPath = await writeBehavior(dir, { revParseHead: HEAD_SHA })
    const verification = await verifyCloneHead(
      dir,
      { kind: 'commit', sha: OTHER_SHA },
      { git: gitPrefix(behaviorPath) }
    )
    expect(verification.ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// runClone executor (real exit codes via fixture git + real rev-parse)
// ---------------------------------------------------------------------------

/** Typed base options for a model clone into `destination`. */
function baseOptions(destination: string): RunCloneOptions {
  return {
    url: MODEL_URL,
    kind: 'model',
    id: 'author/model',
    destination
  }
}

describe('runClone success paths', () => {
  it('clones a branch and verifies HEAD equals the origin tip', async () => {
    const root = scratch('t29-run-')
    const dest = join(root, 'dest')
    const calls: string[][] = []
    const behaviorPath = await writeBehavior(root, {
      revParseHead: HEAD_SHA,
      refs: { 'refs/remotes/origin/main': HEAD_SHA }
    })
    const progressStderr =
      'remote: Enumerating objects: 3, done.\rReceiving objects: 100% (3/3), done.\n'

    const result = await runClone({
      ...baseOptions(dest),
      url: MODEL_URL,
      destination: dest,
      revision: { kind: 'branch', name: 'main' },
      git: gitPrefix(behaviorPath),
      spawn: simulatedCloneSpawn(calls, { stderrByVerb: { clone: progressStderr } })
    })

    expect(result.headSha).toBe(HEAD_SHA)
    expect(result.argv).toEqual([
      'node',
      FIXTURE_GIT,
      behaviorPath,
      'clone',
      '--progress',
      '--branch',
      'main',
      '--single-branch',
      MODEL_URL,
      dest
    ])
    expect(result.phases.map((p) => p.phase)).toContain('receiving')
    expect(calls[0]).toEqual([
      'clone',
      '--progress',
      '--branch',
      'main',
      '--single-branch',
      MODEL_URL,
      dest
    ])
    expect(result.diagnostics).toEqual([])
  })

  it('clones a full commit via no-checkout + fetch + detached checkout', async () => {
    const root = scratch('t29-run-')
    const dest = join(root, 'dest')
    const calls: string[][] = []
    const behaviorPath = await writeBehavior(root, { revParseHead: HEAD_SHA })

    const result = await runClone({
      ...baseOptions(dest),
      url: MODEL_URL,
      destination: dest,
      revision: { kind: 'commit', sha: HEAD_SHA },
      git: gitPrefix(behaviorPath),
      spawn: simulatedCloneSpawn(calls, {
        stderrByVerb: { checkout: 'Checking out files: 100% (2/2), done.\n' }
      })
    })

    expect(result.headSha).toBe(HEAD_SHA)
    expect(calls).toEqual([
      ['clone', '--progress', '--no-checkout', MODEL_URL, dest],
      ['-C', dest, 'fetch', 'origin', HEAD_SHA],
      ['-C', dest, 'checkout', '--detach', HEAD_SHA]
    ])
    expect(result.phases.map((p) => p.phase)).toContain('checkout')
  })

  it('clones with no revision and reports a valid HEAD', async () => {
    const root = scratch('t29-run-')
    const dest = join(root, 'dest')
    const calls: string[][] = []
    const behaviorPath = await writeBehavior(root, { revParseHead: HEAD_SHA })

    const result = await runClone({
      ...baseOptions(dest),
      url: MODEL_URL,
      destination: dest,
      git: gitPrefix(behaviorPath),
      spawn: simulatedCloneSpawn(calls)
    })

    expect(result.headSha).toBe(HEAD_SHA)
    expect(result.argv).toEqual([
      'node',
      FIXTURE_GIT,
      behaviorPath,
      'clone',
      '--progress',
      MODEL_URL,
      dest
    ])
  })

  it('preserves unknown stderr as bounded, redacted diagnostics', async () => {
    const root = scratch('t29-run-')
    const dest = join(root, 'dest')
    const calls: string[][] = []
    const behaviorPath = await writeBehavior(root, { revParseHead: HEAD_SHA })

    const result = await runClone({
      ...baseOptions(dest),
      url: MODEL_URL,
      destination: dest,
      git: gitPrefix(behaviorPath),
      spawn: simulatedCloneSpawn(calls, {
        stderrByVerb: {
          clone:
            "Cloning into 'dest'...\nremote: Total 3 (delta 0), reused 0 (delta 0), pack-reused 0\n"
        }
      })
    })

    expect(result.diagnostics.length).toBe(2)
    expect(result.diagnostics[0]).toContain('Cloning into')
  })
})

describe('runClone failure paths', () => {
  const cases: Array<[string, string, string]> = [
    ['auth', "fatal: Authentication failed for 'https://huggingface.co/author/model/'\n", 'auth'],
    [
      'gated',
      'remote: Access to repository author/repo is disabled.\nfatal: The requested URL returned error: 403\n',
      'gated'
    ],
    ['xet', "fatal: external filter 'git-xet filter' failed\n", 'dependency'],
    ['not-found', "fatal: repository 'https://huggingface.co/x/y' not found\n", 'not-found'],
    [
      'proxy',
      "fatal: unable to access 'https://huggingface.co/author/model': Could not resolve proxy: localhost\n",
      'proxy'
    ],
    [
      'network',
      "fatal: unable to access 'https://huggingface.co/author/model': Failed to connect to huggingface.co port 443: Connection refused\n",
      'network'
    ],
    ['disk', "fatal: unable to create file 'C:/x/file': No space left on device\n", 'disk']
  ]

  it.each(cases)('maps clone stderr to %s', async (_label, stderrText, expectedCode) => {
    const root = scratch('t29-fail-')
    const dest = join(root, 'dest')
    const calls: string[][] = []
    const behaviorPath = await writeBehavior(root, { revParseHead: HEAD_SHA })
    const spawn: (
      git: readonly string[],
      argv: readonly string[],
      env: Readonly<Record<string, string>>,
      timeout: number
    ) => SpawnResult = (_git, argv, _env, _timeout) => {
      calls.push([...argv])
      return { status: 128, stdout: '', stderr: stderrText, error: null }
    }

    await expect(
      runClone({
        ...baseOptions(dest),
        url: MODEL_URL,
        destination: dest,
        git: gitPrefix(behaviorPath),
        spawn
      })
    ).rejects.toMatchObject({ code: expectedCode })
    expect(calls.length).toBe(1)
    // The destination is created by the reservation but never deleted.
    const { readdir } = await import('node:fs/promises')
    expect(await readdir(dest)).toEqual([])
  })

  it('rejects option-injection id before any spawn', async () => {
    const root = scratch('t29-inj-')
    const dest = join(root, 'dest')
    const calls: string[][] = []
    const behaviorPath = await writeBehavior(root, { revParseHead: HEAD_SHA })

    await expect(
      runClone({
        ...baseOptions(dest),
        url: 'https://huggingface.co/-evil/model',
        id: '-evil/model',
        destination: dest,
        git: gitPrefix(behaviorPath),
        spawn: simulatedCloneSpawn(calls)
      })
    ).rejects.toBeInstanceOf(CloneExecutionError)
    expect(calls.length).toBe(0)
    const exists = await statExists(dest)
    expect(exists).toBe(false)
  })

  it('rejects option-injection revision before any spawn', async () => {
    const root = scratch('t29-inj-')
    const dest = join(root, 'dest')
    const calls: string[][] = []
    const behaviorPath = await writeBehavior(root, { revParseHead: HEAD_SHA })
    const evilRevision = { kind: 'branch', name: '-evil' } as unknown as CloneRevision

    await expect(
      runClone({
        ...baseOptions(dest),
        url: MODEL_URL,
        destination: dest,
        revision: evilRevision,
        git: gitPrefix(behaviorPath),
        spawn: simulatedCloneSpawn(calls)
      })
    ).rejects.toBeInstanceOf(CloneExecutionError)
    expect(calls.length).toBe(0)
    expect(await statExists(dest)).toBe(false)
  })

  it('rejects a non-derived raw URL before any spawn', async () => {
    const root = scratch('t29-raw-')
    const dest = join(root, 'dest')
    const calls: string[][] = []
    const behaviorPath = await writeBehavior(root, { revParseHead: HEAD_SHA })

    await expect(
      runClone({
        ...baseOptions(dest),
        url: 'https://evil.example.com/author/model',
        destination: dest,
        git: gitPrefix(behaviorPath),
        spawn: simulatedCloneSpawn(calls)
      })
    ).rejects.toBeInstanceOf(CloneExecutionError)
    expect(calls.length).toBe(0)
    expect(await statExists(dest)).toBe(false)
  })

  it('rejects a URL that does not match the requested kind/id before any spawn', async () => {
    const root = scratch('t29-mix-')
    const dest = join(root, 'dest')
    const calls: string[][] = []
    const behaviorPath = await writeBehavior(root, { revParseHead: HEAD_SHA })

    await expect(
      runClone({
        ...baseOptions(dest),
        url: 'https://huggingface.co/author/other',
        id: 'author/model',
        destination: dest,
        git: gitPrefix(behaviorPath),
        spawn: simulatedCloneSpawn(calls)
      })
    ).rejects.toBeInstanceOf(CloneExecutionError)
    expect(calls.length).toBe(0)
  })

  it('rejects a nonempty destination before any spawn, without deleting it', async () => {
    const root = scratch('t29-nonempty-')
    const dest = join(root, 'dest')
    await mkdir(dest)
    await writeFile(join(dest, 'existing.txt'), 'keep me')
    const calls: string[][] = []
    const behaviorPath = await writeBehavior(root, { revParseHead: HEAD_SHA })

    await expect(
      runClone({
        ...baseOptions(dest),
        url: MODEL_URL,
        destination: dest,
        git: gitPrefix(behaviorPath),
        spawn: simulatedCloneSpawn(calls)
      })
    ).rejects.toBeInstanceOf(DestinationError)
    expect(calls.length).toBe(0)
    const { readFile } = await import('node:fs/promises')
    expect(await readFile(join(dest, 'existing.txt'), 'utf8')).toBe('keep me')
  })

  it('fails a commit clone whose HEAD does not match the requested sha', async () => {
    const root = scratch('t29-commit-mismatch-')
    const dest = join(root, 'dest')
    const calls: string[][] = []
    const behaviorPath = await writeBehavior(root, { revParseHead: HEAD_SHA })

    await expect(
      runClone({
        ...baseOptions(dest),
        revision: { kind: 'commit', sha: OTHER_SHA },
        git: gitPrefix(behaviorPath),
        // The checkout does not update HEAD (e.g. a ref-missing server); the
        // final verification must catch the mismatch.
        spawn: simulatedCloneSpawn(calls, { checkoutWritesHead: false })
      })
    ).rejects.toMatchObject({ code: 'internal' })
  })

  it('maps a failed checkout to a typed error and preserves the destination', async () => {
    const root = scratch('t29-checkout-fail-')
    const dest = join(root, 'dest')
    const calls: string[][] = []
    const behaviorPath = await writeBehavior(root, { revParseHead: HEAD_SHA })
    const spawn: (
      git: readonly string[],
      argv: readonly string[],
      env: Readonly<Record<string, string>>,
      timeout: number
    ) => SpawnResult = (_git, argv, _env, _timeout) => {
      calls.push([...argv])
      if (argv[0] === '-C' && argv[2] === 'checkout') {
        return {
          status: 128,
          stdout: '',
          stderr: 'fatal: reference is not a tree: deadbeef\n',
          error: null
        }
      }
      return { status: 0, stdout: '', stderr: '', error: null }
    }

    await expect(
      runClone({
        ...baseOptions(dest),
        url: MODEL_URL,
        destination: dest,
        revision: { kind: 'commit', sha: HEAD_SHA },
        git: gitPrefix(behaviorPath),
        spawn
      })
    ).rejects.toBeInstanceOf(CloneExecutionError)
    expect(calls.length).toBe(3)
    const { readdir } = await import('node:fs/promises')
    expect(await readdir(dest)).toEqual([])
  })
})

async function statExists(path: string): Promise<boolean> {
  const { stat } = await import('node:fs/promises')
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
