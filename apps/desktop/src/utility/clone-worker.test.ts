// apps/desktop/src/utility/clone-worker.test.ts
//
// Todo 27 worker contract tests (deterministic, no processes):
//   - emits ready with the injected PID and stays idle
//   - refuses start BEFORE arm (early / missing envelope) — no spawn
//   - refuses a tampered envelope (hash mismatch) — no spawn
//   - arms only for the exact frozen envelope, then start spawns Git exactly
//     once with the exact argv/cwd/env
//   - streams progress/log from git output (typed, bounded)
//   - cooperative cancel acks and kills the child; terminal is emitted once
//   - terminal is a final state: further commands are ignored
import { describe, expect, it, vi } from 'vitest'
import type { CloneCommand, CloneEnvelope, CloneEvent } from './clone-protocol'
import { hashEnvelope } from './clone-protocol'
import { createCloneWorker, type CloneWorkerPort, type GitChildLike } from './clone-worker'

function makeEnvelope(overrides: Partial<CloneEnvelope> = {}): CloneEnvelope {
  return {
    version: 1,
    assignmentId: 'a1',
    git: 'C:\\fake\\git.exe',
    argv: ['clone', '--progress', 'https://huggingface.co/org/repo', 'dest'],
    cwd: 'C:\\work',
    env: { GIT_TERMINAL_PROMPT: '0' },
    ...overrides
  }
}

interface FakeChild extends GitChildLike {
  exitHandlers: Array<(code: number | null, signal: string | null) => void>
  emitExit(code: number | null, signal?: string | null): void
  emitStderr(line: string): void
  emitStdout(line: string): void
  killed: boolean
}

function makeFakeChild(pid = 4242): FakeChild {
  const exitHandlers: Array<(code: number | null, signal: string | null) => void> = []
  const child: FakeChild = {
    pid,
    exitHandlers,
    killed: false,
    stderr: null,
    stdout: null,
    on: vi.fn((event: 'exit', listener: (code: number | null, signal: string | null) => void) => {
      if (event === 'exit') exitHandlers.push(listener)
    }) as FakeChild['on'],
    kill: vi.fn(() => {
      child.killed = true
      return true
    }) as FakeChild['kill'],
    emitExit: (code, signal = null) => {
      for (const handler of [...exitHandlers]) handler(code, signal)
    },
    emitStderr: (line) => {
      for (const handler of stderrHandlers) handler(line)
    },
    emitStdout: (line) => {
      for (const handler of stdoutHandlers) handler(line)
    }
  }
  const stderrHandlers: Array<(chunk: Buffer | string) => void> = []
  const stdoutHandlers: Array<(chunk: Buffer | string) => void> = []
  child.stderr = { on: vi.fn((_e, h) => stderrHandlers.push(h)) as never }
  child.stdout = { on: vi.fn((_e, h) => stdoutHandlers.push(h)) as never }
  return child
}

interface Harness {
  events: CloneEvent[]
  port: CloneWorkerPort
  spawnGit: ReturnType<typeof vi.fn>
  child: FakeChild
  sent: CloneCommand[]
  exitCalls: number[]
  drive(command: CloneCommand): void
}

function makeHarness(childPid = 4242): Harness {
  const events: CloneEvent[] = []
  const sent: CloneCommand[] = []
  const child = makeFakeChild(childPid)
  const spawnGit = vi.fn(() => child)
  const exitCalls: number[] = []
  let listener: ((command: CloneCommand) => void) | null = null
  const port: CloneWorkerPort = {
    postMessage: (event) => events.push(event),
    onMessage: (cb) => {
      listener = cb
    }
  }
  const worker = createCloneWorker({
    port,
    spawnGit,
    getPid: () => childPid,
    exit: (code) => exitCalls.push(code ?? 0)
  })
  worker.start()
  return {
    events,
    port,
    spawnGit,
    child,
    sent,
    exitCalls,
    drive: (command) => listener?.(command)
  }
}

const eventsOfType = (events: CloneEvent[], type: CloneEvent['type']): CloneEvent[] =>
  events.filter((e) => e.type === type)

describe('clone-worker: idle boot', () => {
  it('emits ready with the injected PID and never spawns Git', () => {
    const h = makeHarness(7777)
    expect(h.events[0]).toEqual({ type: 'ready', pid: 7777 })
    expect(h.spawnGit).not.toHaveBeenCalled()
  })
})

describe('clone-worker: envelope gating (assign-before-start)', () => {
  it('refuses start BEFORE arm with a typed early-start refusal and no spawn', () => {
    const h = makeHarness()
    h.drive({ type: 'start', assignmentId: 'a1' })
    const refusals = eventsOfType(h.events, 'refused')
    expect(refusals).toHaveLength(1)
    expect(refusals[0]).toMatchObject({ code: 'missing-envelope' })
    expect(h.spawnGit).not.toHaveBeenCalled()
  })

  it('refuses a start for an unknown assignment while idle', () => {
    const h = makeHarness()
    h.drive({ type: 'start', assignmentId: 'other' })
    const refusals = eventsOfType(h.events, 'refused')
    expect(refusals[0]).toMatchObject({ code: 'missing-envelope' })
    expect(h.spawnGit).not.toHaveBeenCalled()
  })

  it('refuses an arm whose envelope hash does not match (tampered)', () => {
    const h = makeHarness()
    const envelope = makeEnvelope()
    h.drive({ type: 'arm', assignmentId: 'a1', envelope, envelopeHash: 'deadbeef' })
    const refusals = eventsOfType(h.events, 'refused')
    expect(refusals).toHaveLength(1)
    expect(refusals[0]).toMatchObject({ code: 'tampered-envelope' })
    expect(h.spawnGit).not.toHaveBeenCalled()
    // worker stays idle: a later correct arm + start must still work
    const envelopeHash = hashEnvelope(envelope)
    h.drive({ type: 'arm', assignmentId: 'a1', envelope, envelopeHash })
    expect(eventsOfType(h.events, 'armed')).toHaveLength(1)
    h.drive({ type: 'start', assignmentId: 'a1' })
    expect(h.spawnGit).toHaveBeenCalledTimes(1)
  })

  it('refuses an arm with a structurally invalid envelope (tampered)', () => {
    const h = makeHarness()
    const bad = { ...makeEnvelope(), git: '' }
    h.drive({ type: 'arm', assignmentId: 'a1', envelope: bad, envelopeHash: hashEnvelope(bad) })
    const refusals = eventsOfType(h.events, 'refused')
    expect(refusals[0]).toMatchObject({ code: 'tampered-envelope' })
    expect(h.spawnGit).not.toHaveBeenCalled()
  })

  it('refuses a start that does not match the armed assignment (early start)', () => {
    const h = makeHarness()
    const envelope = makeEnvelope()
    const envelopeHash = hashEnvelope(envelope)
    h.drive({ type: 'arm', assignmentId: 'a1', envelope, envelopeHash })
    expect(eventsOfType(h.events, 'armed')).toHaveLength(1)
    h.drive({ type: 'start', assignmentId: 'different' })
    const refusals = eventsOfType(h.events, 'refused')
    expect(refusals[0]).toMatchObject({ code: 'unknown-assignment' })
    expect(h.spawnGit).not.toHaveBeenCalled()
  })

  it('spawns Git exactly once only after a matching arm + start', () => {
    const h = makeHarness(9999)
    const envelope = makeEnvelope()
    const envelopeHash = hashEnvelope(envelope)
    h.drive({ type: 'arm', assignmentId: 'a1', envelope, envelopeHash })
    expect(h.spawnGit).not.toHaveBeenCalled()
    h.drive({ type: 'start', assignmentId: 'a1' })
    expect(h.spawnGit).toHaveBeenCalledTimes(1)
    expect(h.spawnGit).toHaveBeenCalledWith(envelope)
    expect(eventsOfType(h.events, 'started')[0]).toEqual({
      type: 'started',
      assignmentId: 'a1',
      gitPid: 9999
    })
  })

  it('ignores a second start while running (no double spawn)', () => {
    const h = makeHarness()
    const envelope = makeEnvelope()
    const envelopeHash = hashEnvelope(envelope)
    h.drive({ type: 'arm', assignmentId: 'a1', envelope, envelopeHash })
    h.drive({ type: 'start', assignmentId: 'a1' })
    h.drive({ type: 'start', assignmentId: 'a1' })
    expect(h.spawnGit).toHaveBeenCalledTimes(1)
  })
})

describe('clone-worker: progress + log streaming', () => {
  it('forwards git output as typed log + progress events', () => {
    const h = makeHarness()
    const envelope = makeEnvelope()
    const envelopeHash = hashEnvelope(envelope)
    h.drive({ type: 'arm', assignmentId: 'a1', envelope, envelopeHash })
    h.drive({ type: 'start', assignmentId: 'a1' })
    h.child.emitStderr('Cloning into dest...\n')
    h.child.emitStderr('Receiving objects: 42% (84/200)\n')
    h.child.emitStderr('Resolving deltas: 50% (10/20)\n')
    h.child.emitStderr('Checking out files: 100% (2/2)\n')
    const logs = eventsOfType(h.events, 'log').map((e) => (e as { line: string }).line)
    expect(logs).toContain('Receiving objects: 42% (84/200)')
    const progress = eventsOfType(h.events, 'progress')
    expect(progress).toEqual([
      {
        type: 'progress',
        assignmentId: 'a1',
        phase: 'Receiving',
        percent: 42,
        detail: 'Receiving objects: 42% (84/200)'
      },
      {
        type: 'progress',
        assignmentId: 'a1',
        phase: 'Resolving',
        percent: 50,
        detail: 'Resolving deltas: 50% (10/20)'
      },
      {
        type: 'progress',
        assignmentId: 'a1',
        phase: 'Checking out',
        percent: 100,
        detail: 'Checking out files: 100% (2/2)'
      }
    ])
  })

  it('clamps progress percent into 0..100', () => {
    const h = makeHarness()
    const envelope = makeEnvelope()
    h.drive({ type: 'arm', assignmentId: 'a1', envelope, envelopeHash: hashEnvelope(envelope) })
    h.drive({ type: 'start', assignmentId: 'a1' })
    h.child.emitStderr('Receiving objects: 150% (300/200)\n')
    const progress = eventsOfType(h.events, 'progress')
    expect(progress[0]).toMatchObject({ percent: 100 })
  })

  it('bounded log lines are truncated', () => {
    const h = makeHarness()
    const envelope = makeEnvelope()
    h.drive({ type: 'arm', assignmentId: 'a1', envelope, envelopeHash: hashEnvelope(envelope) })
    h.drive({ type: 'start', assignmentId: 'a1' })
    h.child.emitStderr(`${'x'.repeat(600)}\n`)
    const logs = eventsOfType(h.events, 'log')
    expect((logs[0] as { line: string }).line.length).toBeLessThanOrEqual(513)
  })
})

describe('clone-worker: terminal', () => {
  it('emits completed terminal once on exit code 0', () => {
    const h = makeHarness()
    const envelope = makeEnvelope()
    h.drive({ type: 'arm', assignmentId: 'a1', envelope, envelopeHash: hashEnvelope(envelope) })
    h.drive({ type: 'start', assignmentId: 'a1' })
    h.child.emitExit(0)
    const terminals = eventsOfType(h.events, 'terminal')
    expect(terminals).toHaveLength(1)
    expect(terminals[0]).toEqual({
      type: 'terminal',
      assignmentId: 'a1',
      outcome: 'completed',
      exitCode: 0,
      signal: null
    })
    expect(h.exitCalls).toEqual([0])
  })

  it('emits failed terminal once on non-zero exit', () => {
    const h = makeHarness()
    const envelope = makeEnvelope()
    h.drive({ type: 'arm', assignmentId: 'a1', envelope, envelopeHash: hashEnvelope(envelope) })
    h.drive({ type: 'start', assignmentId: 'a1' })
    h.child.emitExit(128)
    const terminals = eventsOfType(h.events, 'terminal')
    expect(terminals).toHaveLength(1)
    expect(terminals[0]).toMatchObject({ outcome: 'failed', exitCode: 128 })
  })

  it('terminal is emitted exactly once even on duplicate exit events', () => {
    const h = makeHarness()
    const envelope = makeEnvelope()
    h.drive({ type: 'arm', assignmentId: 'a1', envelope, envelopeHash: hashEnvelope(envelope) })
    h.drive({ type: 'start', assignmentId: 'a1' })
    h.child.emitExit(0)
    h.child.emitExit(1)
    expect(eventsOfType(h.events, 'terminal')).toHaveLength(1)
    expect(h.exitCalls).toHaveLength(1)
  })

  it('ignores further commands after terminal', () => {
    const h = makeHarness()
    const envelope = makeEnvelope()
    const envelopeHash = hashEnvelope(envelope)
    h.drive({ type: 'arm', assignmentId: 'a1', envelope, envelopeHash })
    h.drive({ type: 'start', assignmentId: 'a1' })
    h.child.emitExit(0)
    // a rogue arm/start after terminal must be ignored entirely
    h.drive({
      type: 'arm',
      assignmentId: 'a2',
      envelope: makeEnvelope({ assignmentId: 'a2' }),
      envelopeHash: hashEnvelope(makeEnvelope({ assignmentId: 'a2' }))
    })
    h.drive({ type: 'start', assignmentId: 'a2' })
    expect(h.spawnGit).toHaveBeenCalledTimes(1)
    expect(eventsOfType(h.events, 'started')).toHaveLength(1)
  })
})

describe('clone-worker: cooperative cancellation', () => {
  it('acks cancel while running, kills the child, emits cancelled terminal once', () => {
    const h = makeHarness()
    const envelope = makeEnvelope()
    h.drive({ type: 'arm', assignmentId: 'a1', envelope, envelopeHash: hashEnvelope(envelope) })
    h.drive({ type: 'start', assignmentId: 'a1' })
    h.drive({ type: 'cancel', assignmentId: 'a1', reason: 'user' })
    expect(eventsOfType(h.events, 'cancel-ack')).toHaveLength(1)
    expect(h.child.killed).toBe(true)
    const terminals = eventsOfType(h.events, 'terminal')
    expect(terminals).toHaveLength(1)
    expect(terminals[0]).toMatchObject({ outcome: 'cancelled' })
    // child exit later must not emit a second terminal
    h.child.emitExit(0)
    expect(eventsOfType(h.events, 'terminal')).toHaveLength(1)
    expect(h.exitCalls).toHaveLength(1)
  })

  it('acks cancel while idle and transitions to cancelled terminal without spawning', () => {
    const h = makeHarness()
    h.drive({ type: 'cancel', assignmentId: 'a1', reason: 'shutdown' })
    expect(eventsOfType(h.events, 'cancel-ack')).toHaveLength(1)
    expect(eventsOfType(h.events, 'terminal')[0]).toMatchObject({ outcome: 'cancelled' })
    expect(h.spawnGit).not.toHaveBeenCalled()
    expect(h.exitCalls).toHaveLength(1)
  })
})
