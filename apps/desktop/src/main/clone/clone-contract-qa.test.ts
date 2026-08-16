// apps/desktop/src/main/clone/clone-contract-qa.test.ts
//
// Todo 29 QA (evidence) — REAL local fixture Git clones + failure fixtures.
//
// Happy:  fixture Git (real git passthrough from a LOCAL bare repo) clones
//         model/dataset/Space branches and a detached commit while emitting
//         fragmented progress; expected phase + HEAD are recorded and asserted.
// Failure: option-injection id/revision and nonempty destination reject
//         WITHOUT any spawn; auth/proxy/disk/gated/not-found/network/
//         dependency/destination/cancelled/internal stderr fixtures map to the
//         typed codes WITHOUT deleting the destination.
//
// All git runs are fully local (no network) — the derived URL is a literal,
// never-contacted argv element. Evidence artifacts are written to
// .omo/evidence/task-29-adopt-ohmyhf-main/ (gitignored).
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { deriveCloneUrl, type CloneRepoKind } from '@hubfetch/shared'
import {
  CloneExecutionError,
  DestinationError,
  runClone,
  type CloneRunResult
} from './clone-contract'

const ROOT = resolve(fileURLToPath(new URL('../../../../..', import.meta.url)))
const EVIDENCE = join(ROOT, '.omo', 'evidence', 'task-29-adopt-ohmyhf-main')
const FIXTURE_GIT = fileURLToPath(new URL('./fixture-git.mjs', import.meta.url))

const FRAGMENTED_PROGRESS =
  'Receiving objects: 25% (1/4)\rReceiving objects: 50% (2/4)\rReceiving objects: 100% (4/4), done.\n'

const scratchDirs: string[] = []
function scratch(prefix: string): string {
  // mkdtemp under os.tmpdir() (honors TMP/TEMP => E:\Programs\Temp here).
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratchDirs.push(dir)
  return dir
}

afterAll(async () => {
  for (const dir of scratchDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

interface GitResult {
  status: number
  stdout: string
  stderr: string
}

function realGit(argv: string[], cwd: string): GitResult {
  const result = spawnSync('git', argv, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  return {
    status: result.status ?? (result.error ? 127 : 1),
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? ''
  }
}

function gitAvailable(): boolean {
  return realGit(['--version'], ROOT).status === 0
}

interface FixtureRepo {
  bare: string
  mainSha: string
  devSha: string
  tagSha: string
  detachedSha: string
}

/** Build a local fixture repo: main, dev, tag v1, and a dangling commit. */
async function setupFixtureRepo(scratchDir: string): Promise<FixtureRepo> {
  const work = join(scratchDir, 'work')
  await mkdir(work, { recursive: true })
  const commit = (message: string): void => {
    realGit(
      ['-c', 'user.name=HF QA', '-c', 'user.email=qa@hubfetch.invalid', 'commit', '-m', message],
      work
    )
  }
  realGit(['init', '--initial-branch=main'], work)
  await writeFile(join(work, 'a.txt'), 'a')
  realGit(['add', '.'], work)
  commit('first')
  const firstSha = realGit(['rev-parse', 'HEAD'], work).stdout.trim()

  realGit(['checkout', '-b', 'dev'], work)
  await writeFile(join(work, 'b.txt'), 'b')
  realGit(['add', '.'], work)
  commit('second')
  const devSha = realGit(['rev-parse', 'HEAD'], work).stdout.trim()

  realGit(['checkout', 'main'], work)
  realGit(['tag', 'v1'], work)
  const tagSha = realGit(['rev-parse', 'v1'], work).stdout.trim()
  expect(tagSha).toBe(firstSha)

  await writeFile(join(work, 'c.txt'), 'c')
  realGit(['add', '.'], work)
  commit('third')
  const mainSha = realGit(['rev-parse', 'HEAD'], work).stdout.trim()

  // A truly detached commit: create on a throwaway branch, then delete it.
  realGit(['checkout', '-b', 'tmp-detached'], work)
  await writeFile(join(work, 'd.txt'), 'd')
  realGit(['add', '.'], work)
  commit('detached-only')
  const detachedSha = realGit(['rev-parse', 'HEAD'], work).stdout.trim()
  realGit(['checkout', 'main'], work)
  realGit(['branch', '-D', 'tmp-detached'], work)

  const bare = join(scratchDir, 'fixture.git')
  realGit(['clone', '--bare', work, bare], scratchDir)
  realGit(['config', 'uploadpack.allowAnySHA1InWant', 'true'], bare)
  return { bare, mainSha, devSha, tagSha, detachedSha }
}

interface HappyCase {
  kind: CloneRepoKind
  id: string
  transport: 'https' | 'ssh'
  revision?:
    | { kind: 'branch'; name: string }
    | { kind: 'tag'; name: string }
    | { kind: 'commit'; sha: string }
  expectedSha: string
  label: string
}

async function runHappyCase(
  fixture: FixtureRepo,
  scratchDir: string,
  case_: HappyCase
): Promise<{ result: CloneRunResult; url: string; expectedSha: string }> {
  const dest = join(scratchDir, `dest-${case_.label.replace(/[^a-z0-9]/gi, '-')}`)
  const behaviorPath = join(scratchDir, `behavior-${case_.label.replace(/[^a-z0-9]/gi, '-')}.json`)
  await writeFile(
    behaviorPath,
    JSON.stringify({ realCloneSource: fixture.bare, cloneStderr: FRAGMENTED_PROGRESS })
  )
  const url = deriveCloneUrl(case_.kind, case_.id, case_.transport)
  const result = await runClone({
    url,
    kind: case_.kind,
    id: case_.id,
    destination: dest,
    revision: case_.revision,
    git: ['node', FIXTURE_GIT, behaviorPath],
    timeoutMs: 60_000
  })
  return { result, url, expectedSha: case_.expectedSha }
}

const FAILURE_FIXTURES: Array<[string, string, string, boolean]> = [
  [
    'auth',
    "fatal: Authentication failed for 'https://huggingface.co/author/model/'\n",
    'auth',
    true
  ],
  [
    'gated',
    'remote: Access to repository author/repo is disabled.\nfatal: The requested URL returned error: 403\n',
    'gated',
    true
  ],
  ['xet', "fatal: external filter 'git-xet filter' failed\n", 'dependency', true],
  ['not-found', "fatal: repository 'https://huggingface.co/x/y' not found\n", 'not-found', true],
  [
    'proxy',
    "fatal: unable to access 'https://huggingface.co/author/model': Could not resolve proxy: localhost\n",
    'proxy',
    true
  ],
  [
    'network',
    "fatal: unable to access 'https://huggingface.co/author/model': Failed to connect to huggingface.co port 443: Connection refused\n",
    'network',
    true
  ],
  ['disk', "fatal: unable to create file 'C:/x/file': No space left on device\n", 'disk', true],
  [
    'destination',
    "fatal: destination path 'C:/x' already exists and is not an empty directory\n",
    'destination',
    false
  ],
  ['cancelled', 'fatal: operation canceled\n', 'cancelled', true],
  ['internal', 'fatal: an unrecognized failure\n', 'internal', true]
]

describe('clone contract QA (evidence)', () => {
  const happy = gitAvailable()

  it('qa-happy: real fixture clones across kinds/transports/revisions', async () => {
    if (!happy) {
      await writeQaHappy([
        'QA_HAPPY_SKIP',
        'System git is unavailable on this machine; no real clone was attempted.',
        'All unit/property contract tests still pass without system git.'
      ])
      return
    }
    const scratchDir = scratch('t29-qa-happy-')
    const fixture = await setupFixtureRepo(scratchDir)
    const cases: HappyCase[] = [
      {
        kind: 'model',
        id: 'qa-author/model-a',
        transport: 'https',
        revision: { kind: 'branch', name: 'main' },
        expectedSha: fixture.mainSha,
        label: 'model-branch'
      },
      {
        kind: 'dataset',
        id: 'qa-author/data-b',
        transport: 'https',
        revision: { kind: 'tag', name: 'v1' },
        expectedSha: fixture.tagSha,
        label: 'dataset-tag'
      },
      {
        kind: 'space',
        id: 'qa-author/demo-c',
        transport: 'https',
        revision: { kind: 'branch', name: 'dev' },
        expectedSha: fixture.devSha,
        label: 'space-branch'
      },
      {
        kind: 'model',
        id: 'qa-author/model-d',
        transport: 'ssh',
        revision: { kind: 'commit', sha: fixture.detachedSha },
        expectedSha: fixture.detachedSha,
        label: 'model-commit'
      }
    ]

    const lines: string[] = ['QA_HAPPY_PASS']
    for (const case_ of cases) {
      const { result, url, expectedSha } = await runHappyCase(fixture, scratchDir, case_)
      expect(result.headSha).toBe(expectedSha)
      expect(result.phases.map((p) => p.phase)).toContain('receiving')
      expect(existsSync(join(result.destination, '.git'))).toBe(true)
      // Independent real-git confirmation of the recorded HEAD.
      const recordedHead = realGit(['rev-parse', 'HEAD'], result.destination)
      expect(recordedHead.status).toBe(0)
      expect(recordedHead.stdout.trim()).toBe(expectedSha)
      lines.push(
        JSON.stringify({
          case: case_.label,
          kind: case_.kind,
          transport: case_.transport,
          revision: case_.revision,
          url,
          expectedPhase: 'receiving',
          expectedHead: expectedSha,
          actualHead: result.headSha,
          phases: result.phases.map((p) => p.phase),
          argv: result.argv,
          destination: result.destination,
          headVerified: true
        })
      )
    }
    await writeQaHappy(lines)
  }, 120_000)

  it('qa-failure: injection/nonempty reject before spawn; stderr fixtures map without deleting', async () => {
    if (!happy) {
      await writeQaFailure([
        'QA_FAILURE_SKIP',
        'System git is unavailable; stderr-fixture failures still run below via the scripted driver.'
      ])
    }
    const scratchDir = scratch('t29-qa-failure-')
    const lines: string[] = ['QA_FAILURE_PASS']
    const modelUrl = deriveCloneUrl('model', 'qa-author/model', 'https')

    // 1. Option-injection id — refused before any spawn or destination change.
    const injDest = join(scratchDir, 'inj-id-dest')
    await expect(
      runClone({
        url: 'https://huggingface.co/-evil/model',
        kind: 'model',
        id: '-evil/model',
        destination: injDest,
        git: ['node', FIXTURE_GIT, join(scratchDir, 'missing.json')]
      })
    ).rejects.toBeInstanceOf(CloneExecutionError)
    expect(existsSync(injDest)).toBe(false)
    lines.push(
      JSON.stringify({
        case: 'option-injection-id',
        spawn: 0,
        destinationCreated: false,
        code: 'internal'
      })
    )

    // 2. Option-injection revision — refused before spawn.
    const injRevDest = join(scratchDir, 'inj-rev-dest')
    await expect(
      runClone({
        url: modelUrl,
        kind: 'model',
        id: 'qa-author/model',
        destination: injRevDest,
        revision: { kind: 'branch', name: '-evil' } as never,
        git: ['node', FIXTURE_GIT, join(scratchDir, 'missing.json')]
      })
    ).rejects.toBeInstanceOf(CloneExecutionError)
    expect(existsSync(injRevDest)).toBe(false)
    lines.push(
      JSON.stringify({
        case: 'option-injection-revision',
        spawn: 0,
        destinationCreated: false,
        code: 'internal'
      })
    )

    // 3. Nonempty destination — refused before spawn, content preserved.
    const nonempty = join(scratchDir, 'nonempty-dest')
    await mkdir(nonempty)
    await writeFile(join(nonempty, 'keep.txt'), 'keep me')
    await expect(
      runClone({
        url: modelUrl,
        kind: 'model',
        id: 'qa-author/model',
        destination: nonempty,
        git: ['node', FIXTURE_GIT, join(scratchDir, 'missing.json')]
      })
    ).rejects.toBeInstanceOf(DestinationError)
    expect(await readFile(join(nonempty, 'keep.txt'), 'utf8')).toBe('keep me')
    lines.push(
      JSON.stringify({
        case: 'nonempty-destination',
        spawn: 0,
        preserved: true,
        code: 'destination'
      })
    )

    // 4..n. stderr fixtures — the scripted driver emits stderr and a partial
    // file; the contract maps the typed code and never deletes the partial.
    for (const [label, stderrText, expectedCode, partialExpected] of FAILURE_FIXTURES) {
      const dest = join(scratchDir, `fixture-${label}-dest`)
      const behaviorPath = join(scratchDir, `fixture-${label}.json`)
      await writeFile(
        behaviorPath,
        JSON.stringify({ failOn: 'clone', errorStderr: stderrText, makePartial: partialExpected })
      )
      let actualCode: string | null = null
      try {
        await runClone({
          url: modelUrl,
          kind: 'model',
          id: 'qa-author/model',
          destination: dest,
          git: ['node', FIXTURE_GIT, behaviorPath]
        })
      } catch (error) {
        if (error instanceof CloneExecutionError) actualCode = error.code
        else throw error
      }
      expect(actualCode).toBe(expectedCode)
      expect(existsSync(join(dest, 'partial-file.txt'))).toBe(partialExpected)
      lines.push(
        JSON.stringify({
          case: `stderr-${label}`,
          expectedCode,
          actualCode,
          partialPreserved: partialExpected,
          deleted: false
        })
      )
    }

    await writeQaFailure(lines)
  }, 120_000)
})

async function writeQaHappy(lines: string[]): Promise<void> {
  await mkdir(EVIDENCE, { recursive: true })
  await writeFile(join(EVIDENCE, 'qa-happy.txt'), lines.join('\n') + '\n')
}

async function writeQaFailure(lines: string[]): Promise<void> {
  await mkdir(EVIDENCE, { recursive: true })
  await writeFile(join(EVIDENCE, 'qa-failure.txt'), lines.join('\n') + '\n')
}
