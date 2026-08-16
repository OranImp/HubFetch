// apps/desktop/src/main/clone/clone-host.test.ts
//
// Todo 27 CloneHost contract tests (deterministic, no real processes):
//   - message-order proof: spawn -> ready -> assign -> contains -> arm -> start
//   - clone gate + createJob/assign/contains failures are typed records with
//     no envelope sent and no Git spawned
//   - cooperative cancel -> grace -> terminate -> Job zero
//   - non-cooperative cancel reaches zero via Job termination
//   - app shutdown (multiple active) reaches zero for every clone
//   - utility crash before terminal is classified interrupted, descendants zero
//   - all timers/ports/handles closed after settle
//   - main event loop remains responsive while a clone is in flight
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CloneEnvelope, CloneEvent } from '../../utility/clone-protocol'
import { hashEnvelope } from '../../utility/clone-protocol'
import { CloneHost, type CloneRunRecord, type ForkFn, type UtilityProcessLike } from './clone-host'
import type {
  HubFetchJobBridge,
  HubFetchJobHandle,
  HubFetchJobOpResult
} from '../native/hubfetch-job-loader'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => 'C:\\dev\\apps\\desktop'
  }
}))

class FakeUtility extends EventEmitter implements UtilityProcessLike {
  pid: number | undefined = undefined
  posted: unknown[] = []
  killed = false
  constructor(public readonly assignedPid: number) {
    super()
    this.pid = assignedPid
  }

  postMessage(message: unknown): void {
    this.posted.push(message)
  }

  kill(): boolean {
    this.killed = true
    return true
  }

  /** Test helper: simulate the worker's reply. */
  workerReply(message: CloneEvent): void {
    this.emit('message', message)
  }

  spawn(): void {
    this.emit('spawn')
  }

  crash(code: number): void {
    this.emit('exit', code)
  }
}

function makeJob(): HubFetchJobHandle & {
  assignProcess: ReturnType<typeof vi.fn>
  containsProcess: ReturnType<typeof vi.fn>
  activeProcessIds: ReturnType<typeof vi.fn>
  terminate: ReturnType<typeof vi.fn>
  waitForEmpty: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
} {
  return {
    assignProcess: vi.fn(() => ({ ok: true }) as const satisfies HubFetchJobOpResult),
    containsProcess: vi.fn(() => ({ ok: true as const, contains: true })),
    activeProcessIds: vi.fn(() => ({ ok: true as const, pids: [] })),
    terminate: vi.fn(() => ({ ok: true }) as const satisfies HubFetchJobOpResult),
    waitForEmpty: vi.fn(async () => ({ ok: true }) as const satisfies HubFetchJobOpResult),
    close: vi.fn(() => ({ ok: true }) as const)
  }
}

function makeBridge(job: ReturnType<typeof makeJob>): HubFetchJobBridge {
  return {
    status: 'ready',
    addonPath: 'C:\\dev\\apps\\desktop\\native\\windows\\build\\Release\\hubfetch_job.node',
    runtimeInfo: {
      addonName: 'hubfetch_job',
      addonVersion: '0.2.0',
      nodeAbi: 148,
      arch: 'x64',
      napiVersion: 10
    },
    probeJob: () => ({ ok: true }),
    createJob: () => ({ ok: true, handle: job })
  }
}

function makeEnvelope(assignmentId = 'a1'): CloneEnvelope {
  return {
    version: 1,
    assignmentId,
    git: 'C:\\fake\\git.exe',
    argv: ['clone', '--progress', 'https://huggingface.co/org/repo', 'dest'],
    cwd: 'C:\\work',
    env: { GIT_TERMINAL_PROMPT: '0' }
  }
}

interface Harness {
  host: CloneHost
  job: ReturnType<typeof makeJob>
  bridge: HubFetchJobBridge
  utilities: FakeUtility[]
  taskkillCalls: Array<{ ok: boolean; error?: string }>
}

function makeHarness(
  options: { supportEnabled?: boolean; graceMs?: number; waitMs?: number } = {}
): Harness {
  const job = makeJob()
  const bridge = makeBridge(job)
  const utilities: FakeUtility[] = []
  const taskkillCalls: Array<{ ok: boolean; error?: string }> = []
  const fork: ForkFn = (modulePath, args) => {
    void modulePath
    void args
    const fake = new FakeUtility(0)
    utilities.push(fake)
    return fake
  }
  const host = new CloneHost({
    bridge,
    fork,
    workerModulePath: 'C:\\dev\\apps\\desktop\\out\\main\\clone-worker.mjs',
    getCloneSupport: () => ({
      enabled: options.supportEnabled ?? true,
      reason: null
    }),
    taskkill: (pid) => {
      const result = { ok: true, error: undefined as string | undefined }
      void pid
      taskkillCalls.push(result)
      return result
    },
    graceIntervalMs: options.graceMs ?? 100,
    waitTimeoutMs: options.waitMs ?? 2000,
    emptyTimeoutMs: 2000,
    now: () => Date.now()
  })
  return { host, job, bridge, utilities, taskkillCalls }
}

/** Run a happy-path start and fully settle it via the fake worker. */
async function happyStart(h: Harness): Promise<CloneRunRecord> {
  const envelope = makeEnvelope()
  const p = h.host.startClone({ assignmentId: envelope.assignmentId, envelope })
  const fake = h.utilities[0]
  if (!fake) throw new Error('fork never called')
  fake.workerReply({ type: 'ready', pid: 4242 })
  const expectedHash = hashEnvelope(envelope)
  // arm/start posted synchronously after ready; emit armed then started then terminal.
  await new Promise((r) => setImmediate(r))
  fake.workerReply({ type: 'armed', assignmentId: envelope.assignmentId })
  await new Promise((r) => setImmediate(r))
  fake.workerReply({ type: 'started', assignmentId: envelope.assignmentId, gitPid: 5151 })
  await new Promise((r) => setImmediate(r))
  fake.workerReply({
    type: 'terminal',
    assignmentId: envelope.assignmentId,
    outcome: 'completed',
    exitCode: 0,
    signal: null
  })
  const record = await p
  void expectedHash
  return record
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('CloneHost: message order (assign-before-start)', () => {
  it('proves spawn -> ready -> assign -> contains -> arm -> start', async () => {
    const h = makeHarness()
    const record = await happyStart(h)
    expect(record.steps).toEqual(['spawn', 'ready', 'assign', 'contains', 'arm', 'start'])
    expect(record.outcome).toBe('completed')
    expect(record.zeroProven).toBe(true)
    expect(record.gitPid).toBe(5151)
    expect(record.utilityPid).toBe(4242)
  })

  it('sends arm ONLY after contains confirms membership, and start only after arm', async () => {
    const h = makeHarness()
    const envelope = makeEnvelope()
    const p = h.host.startClone({ assignmentId: envelope.assignmentId, envelope })
    const fake = h.utilities[0]
    if (!fake) throw new Error('fork never called')
    fake.workerReply({ type: 'ready', pid: 4242 })
    await new Promise((r) => setImmediate(r))
    const assign = h.job.assignProcess.mock.calls[0]?.[0]
    expect(assign).toBe(4242)
    const contains = h.job.containsProcess.mock.calls[0]?.[0]
    expect(contains).toBe(4242)
    // arm is posted only after contains confirms membership (assign happened before)
    const assignOrder = h.job.assignProcess.mock.invocationCallOrder[0] ?? 0
    const containsOrder = h.job.containsProcess.mock.invocationCallOrder[0] ?? 0
    expect(containsOrder).toBeGreaterThan(assignOrder)
    expect(fake.posted[0]).toMatchObject({ type: 'arm', assignmentId: 'a1' })
    // start must NOT be sent before the worker acks armed
    const postedBeforeArmed = fake.posted.map((m) => (m as { type: string }).type)
    expect(postedBeforeArmed).toEqual(['arm'])
    fake.workerReply({ type: 'armed', assignmentId: envelope.assignmentId })
    await new Promise((r) => setImmediate(r))
    const postedAfterArmed = fake.posted.map((m) => (m as { type: string }).type)
    expect(postedAfterArmed).toEqual(['arm', 'start'])
    // finish the run
    fake.workerReply({ type: 'started', assignmentId: envelope.assignmentId, gitPid: 7 })
    await new Promise((r) => setImmediate(r))
    fake.workerReply({
      type: 'terminal',
      assignmentId: envelope.assignmentId,
      outcome: 'completed',
      exitCode: 0,
      signal: null
    })
    await p
  })
})

describe('CloneHost: typed failure paths', () => {
  it('gate keeps clones disabled without forking or spawning Git', async () => {
    const h = makeHarness({ supportEnabled: false })
    const envelope = makeEnvelope()
    const record = await h.host.startClone({ assignmentId: envelope.assignmentId, envelope })
    expect(record.outcome).toBe('failed')
    expect(record.error).toContain('clone gated')
    expect(h.utilities).toHaveLength(0)
    expect(h.job.assignProcess).not.toHaveBeenCalled()
  })

  it('createJob failure is a typed record and nothing is forked', async () => {
    const h = makeHarness()
    const failingBridge: HubFetchJobBridge = {
      ...(h.bridge as Extract<HubFetchJobBridge, { status: 'ready' }>),
      createJob: () => ({
        ok: false,
        code: 'HUBFETCH_JOB_CREATE_FAILED',
        errorCode: 'access-denied',
        message: 'CreateJobObjectW denied'
      })
    }
    const host = new CloneHost({
      bridge: failingBridge,
      fork: h.host['fork'],
      workerModulePath: 'x',
      getCloneSupport: () => ({ enabled: true, reason: null })
    })
    const record = await host.startClone({ assignmentId: 'a1', envelope: makeEnvelope() })
    expect(record.outcome).toBe('failed')
    expect(record.error).toContain('HUBFETCH_JOB_CREATE_FAILED')
    expect(h.utilities).toHaveLength(0)
  })

  it('assignProcess failure is typed, Job is closed, no envelope sent', async () => {
    const h = makeHarness()
    h.job.assignProcess.mockReturnValueOnce({
      ok: false,
      code: 'HUBFETCH_JOB_ASSIGN_FAILED',
      errorCode: 'access-denied',
      message: 'could not assign'
    })
    const envelope = makeEnvelope()
    const p = h.host.startClone({ assignmentId: envelope.assignmentId, envelope })
    const fake = h.utilities[0]
    if (!fake) throw new Error('fork never called')
    fake.workerReply({ type: 'ready', pid: 4242 })
    const record = await p
    expect(record.steps).toEqual(['spawn', 'ready', 'assign'])
    expect(record.outcome).toBe('failed')
    expect(record.error).toContain('HUBFETCH_JOB_ASSIGN_FAILED')
    expect(fake.posted).toHaveLength(0)
    expect(h.job.close).toHaveBeenCalledTimes(1)
    expect(h.host.activeIds()).toHaveLength(0)
  })

  it('containsProcess false is typed, no arm is sent', async () => {
    const h = makeHarness()
    h.job.containsProcess.mockReturnValueOnce({ ok: true, contains: false })
    const envelope = makeEnvelope()
    const p = h.host.startClone({ assignmentId: envelope.assignmentId, envelope })
    const fake = h.utilities[0]
    if (!fake) throw new Error('fork never called')
    fake.workerReply({ type: 'ready', pid: 4242 })
    const record = await p
    expect(record.outcome).toBe('failed')
    expect(record.error).toContain('containsProcess')
    expect(fake.posted).toHaveLength(0)
    expect(h.job.close).toHaveBeenCalledTimes(1)
  })
})

describe('CloneHost: cancellation + shutdown reach Job zero', () => {
  it('cooperative cancel acks then terminates Job and proves zero', async () => {
    const h = makeHarness()
    const envelope = makeEnvelope()
    const p = h.host.startClone({ assignmentId: envelope.assignmentId, envelope })
    const fake = h.utilities[0]
    if (!fake) throw new Error('fork never called')
    fake.workerReply({ type: 'ready', pid: 4242 })
    await new Promise((r) => setImmediate(r))
    fake.workerReply({ type: 'armed', assignmentId: envelope.assignmentId })
    await new Promise((r) => setImmediate(r))
    fake.workerReply({ type: 'started', assignmentId: envelope.assignmentId, gitPid: 5151 })
    await new Promise((r) => setImmediate(r))
    const cancelPromise = h.host.cancelClone(envelope.assignmentId)
    await new Promise((r) => setImmediate(r))
    expect(fake.posted.some((m) => (m as { type: string }).type === 'cancel')).toBe(true)
    fake.workerReply({ type: 'cancel-ack', assignmentId: envelope.assignmentId })
    const record = await cancelPromise
    expect(record.outcome).toBe('cancelled')
    expect(h.job.terminate).toHaveBeenCalledTimes(1)
    expect(h.job.waitForEmpty).toHaveBeenCalled()
    expect(record.zeroProven).toBe(true)
    expect(h.job.close).toHaveBeenCalledTimes(1)
    expect(h.host.activeIds()).toHaveLength(0)
    // the original startClone promise must also resolve (job already settled)
    await p
  })

  it('non-cooperative worker still reaches zero via bounded grace + Job terminate', async () => {
    const h = makeHarness({ graceMs: 50, waitMs: 2000 })
    const envelope = makeEnvelope()
    const p = h.host.startClone({ assignmentId: envelope.assignmentId, envelope })
    const fake = h.utilities[0]
    if (!fake) throw new Error('fork never called')
    fake.workerReply({ type: 'ready', pid: 4242 })
    await new Promise((r) => setImmediate(r))
    fake.workerReply({ type: 'armed', assignmentId: envelope.assignmentId })
    await new Promise((r) => setImmediate(r))
    fake.workerReply({ type: 'started', assignmentId: envelope.assignmentId, gitPid: 5151 })
    await new Promise((r) => setImmediate(r))
    // worker never acks cancel — grace expires, Job terminate still proves zero
    const record = await h.host.cancelClone(envelope.assignmentId)
    expect(record.outcome).toBe('cancelled')
    expect(h.job.terminate).toHaveBeenCalledTimes(1)
    expect(record.zeroProven).toBe(true)
    expect(h.job.close).toHaveBeenCalledTimes(1)
    await p
  })

  it('app shutdown cancels every active clone and reaches zero', async () => {
    const h = makeHarness()
    const env1 = makeEnvelope('c1')
    const env2 = makeEnvelope('c2')
    const p1 = h.host.startClone({ assignmentId: 'c1', envelope: env1 })
    const f1 = h.utilities[0]
    f1?.workerReply({ type: 'ready', pid: 1001 })
    await new Promise((r) => setImmediate(r))
    const p2 = h.host.startClone({ assignmentId: 'c2', envelope: env2 })
    const f2 = h.utilities[1]
    f2?.workerReply({ type: 'ready', pid: 1002 })
    await new Promise((r) => setImmediate(r))
    expect(h.host.activeIds().sort()).toEqual(['c1', 'c2'])
    // arm+start both, then let one go terminal and cancel the other cooperatively
    f1?.workerReply({ type: 'armed', assignmentId: 'c1' })
    await new Promise((r) => setImmediate(r))
    f1?.workerReply({ type: 'started', assignmentId: 'c1', gitPid: 1 })
    await new Promise((r) => setImmediate(r))
    f2?.workerReply({ type: 'armed', assignmentId: 'c2' })
    await new Promise((r) => setImmediate(r))
    f2?.workerReply({ type: 'started', assignmentId: 'c2', gitPid: 2 })
    await new Promise((r) => setImmediate(r))
    const shutdownPromise = h.host.shutdown()
    // both workers cooperate
    f1?.workerReply({ type: 'cancel-ack', assignmentId: 'c1' })
    f2?.workerReply({ type: 'cancel-ack', assignmentId: 'c2' })
    const records = await shutdownPromise
    expect(records).toHaveLength(2)
    for (const record of records) {
      expect(record.outcome).toBe('cancelled')
      expect(record.zeroProven).toBe(true)
    }
    expect(h.host.activeIds()).toHaveLength(0)
    await Promise.allSettled([p1, p2])
  })
})

describe('CloneHost: crash handling', () => {
  it('utility exit before terminal is classified interrupted with zero descendants', async () => {
    const h = makeHarness()
    const envelope = makeEnvelope()
    const p = h.host.startClone({ assignmentId: envelope.assignmentId, envelope })
    const fake = h.utilities[0]
    if (!fake) throw new Error('fork never called')
    fake.workerReply({ type: 'ready', pid: 4242 })
    await new Promise((r) => setImmediate(r))
    fake.workerReply({ type: 'armed', assignmentId: envelope.assignmentId })
    await new Promise((r) => setImmediate(r))
    fake.workerReply({ type: 'started', assignmentId: envelope.assignmentId, gitPid: 5151 })
    await new Promise((r) => setImmediate(r))
    fake.crash(1)
    const record = await p
    expect(record.outcome).toBe('interrupted')
    // crash must still prove zero via the Job (worker exit is never trusted alone)
    expect(h.job.waitForEmpty).toHaveBeenCalled()
    expect(record.zeroProven).toBe(true)
    expect(h.job.close).toHaveBeenCalledTimes(1)
    expect(h.host.activeIds()).toHaveLength(0)
  })
})

describe('CloneHost: resource cleanup + loop responsiveness', () => {
  it('closes the Job, clears active state, and leaves no message listeners', async () => {
    const h = makeHarness()
    await happyStart(h)
    expect(h.job.close).toHaveBeenCalledTimes(1)
    expect(h.host.activeIds()).toHaveLength(0)
    const fake = h.utilities[0]
    expect(fake?.listenerCount('message')).toBe(0)
    expect(fake?.listenerCount('exit')).toBe(0)
  })

  it('keeps the main event loop responsive while a clone is in flight', async () => {
    const h = makeHarness()
    const envelope = makeEnvelope()
    let ticks = 0
    const interval = setInterval(() => {
      ticks += 1
    }, 5)
    const p = h.host.startClone({ assignmentId: envelope.assignmentId, envelope })
    // Do NOT reply immediately; let the host wait. The loop must keep ticking.
    await new Promise((r) => setTimeout(r, 80))
    expect(ticks).toBeGreaterThan(0)
    const fake = h.utilities[0]
    if (!fake) throw new Error('fork never called')
    fake.workerReply({ type: 'ready', pid: 4242 })
    await new Promise((r) => setImmediate(r))
    fake.workerReply({ type: 'armed', assignmentId: envelope.assignmentId })
    await new Promise((r) => setImmediate(r))
    fake.workerReply({ type: 'started', assignmentId: envelope.assignmentId, gitPid: 9 })
    await new Promise((r) => setImmediate(r))
    fake.workerReply({
      type: 'terminal',
      assignmentId: envelope.assignmentId,
      outcome: 'completed',
      exitCode: 0,
      signal: null
    })
    await p
    clearInterval(interval)
    expect(h.host.activeIds()).toHaveLength(0)
  })

  it('taskkill degraded fallback is recorded and never substitutes for Job zero', async () => {
    const h = makeHarness({ graceMs: 50 })
    h.job.terminate.mockReturnValueOnce({
      ok: false,
      code: 'HUBFETCH_JOB_TERMINATE_FAILED',
      errorCode: 'access-denied',
      message: 'nope'
    })
    const envelope = makeEnvelope()
    const p = h.host.startClone({ assignmentId: envelope.assignmentId, envelope })
    const fake = h.utilities[0]
    if (!fake) throw new Error('fork never called')
    fake.workerReply({ type: 'ready', pid: 4242 })
    await new Promise((r) => setImmediate(r))
    fake.workerReply({ type: 'armed', assignmentId: envelope.assignmentId })
    await new Promise((r) => setImmediate(r))
    fake.workerReply({ type: 'started', assignmentId: envelope.assignmentId, gitPid: 5151 })
    await new Promise((r) => setImmediate(r))
    const record = await h.host.cancelClone(envelope.assignmentId)
    expect(record.degradedTaskkill).toBe(true)
    expect(h.taskkillCalls).toHaveLength(1)
    // zero is still proven through the Job even after the degraded fallback
    expect(record.zeroProven).toBe(true)
    await p
  })
})
