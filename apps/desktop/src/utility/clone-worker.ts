// apps/desktop/src/utility/clone-worker.ts
//
// Todo 27: the assign-before-start utility-process clone worker.
//
// Runs as an idle Electron utility process (utilityProcess.fork, bundle output
// `out/main/clone-worker.mjs`). It NEVER touches Git by itself:
//
//   - on boot it emits `ready` with its PID and stays idle
//   - main assigns that PID to a Job and confirms membership BEFORE arming
//   - `arm` freezes an immutable start envelope (SHA-256-validated)
//   - `start` (same assignmentId, after arm) is the ONLY thing that spawns Git
//   - a missing / early / tampered envelope is refused with a typed event and
//     no process is ever spawned
//
// The worker logic is a pure factory (createCloneWorker) so vitest can drive it
// deterministically with a fake port + fake spawn; the entry bootstrap below
// wires process.parentPort (utility-process IPC) and the real child_process
// spawn. Never import electron here: the utility process only gets Node.
import { spawn } from 'node:child_process'
import type { CloneCommand, CloneEnvelope, CloneEvent } from './clone-protocol'
import { hashEnvelope, isCloneEnvelope } from './clone-protocol'

/** Minimal MessagePort-like adapter so the runtime is Electron-free. */
export interface CloneWorkerPort {
  postMessage(event: CloneEvent): void
  onMessage(listener: (command: CloneCommand) => void): void
}

/** The subset of a child_process.ChildProcess the worker needs. */
export interface GitChildLike {
  pid?: number
  kill(signal?: NodeJS.Signals | number): boolean
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void
  stderr: { on(event: 'data', listener: (chunk: Buffer | string) => void): void } | null
  stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): void } | null
}
export interface CloneWorkerOptions {
  port: CloneWorkerPort
  spawnGit: (envelope: CloneEnvelope) => GitChildLike
  /** Injectable process PID (tests), defaults to process.pid. */
  getPid?: () => number
  /** Injectable exit (tests), defaults to process.exit. */
  exit?: (code?: number) => void
  /** Max stderr line length forwarded as `log` (bounded output). */
  maxLogLine?: number
}

type WorkerState = 'idle' | 'armed' | 'running' | 'terminal'

const PROGRESS_RE =
  /(?:Receiving objects|Resolving deltas|Updating files|Checking out files):\s*(\d{1,3})\s*%/
const PROGRESS_PHASES: Array<{ match: RegExp; phase: string }> = [
  { match: /^Receiving objects:/, phase: 'Receiving' },
  { match: /^Resolving deltas:/, phase: 'Resolving' },
  { match: /^Updating files:/, phase: 'Updating' },
  { match: /^Checking out files:/, phase: 'Checking out' }
]

interface ArmedContext {
  assignmentId: string
  envelope: CloneEnvelope
  envelopeHash: string
}

/**
 * Pure worker runtime. `start()` begins listening. Returns a stop handle for
 * tests; the real entry never stops explicitly (the Job termination reaps it).
 */
export function createCloneWorker(options: CloneWorkerOptions): { start: () => void } {
  const port = options.port
  const spawnGit = options.spawnGit
  const getPid = options.getPid ?? (() => process.pid)
  const exit = options.exit ?? ((code?: number) => process.exit(code ?? 0))
  const maxLogLine = options.maxLogLine ?? 512

  let state: WorkerState = 'idle'
  let armed: ArmedContext | null = null
  let terminalEmitted = false

  function emit(event: CloneEvent): void {
    port.postMessage(event)
  }

  function refuse(
    assignmentId: string | null,
    code: 'missing-envelope' | 'early-start' | 'tampered-envelope' | 'unknown-assignment',
    message: string
  ): void {
    emit({ type: 'refused', assignmentId, code, message })
  }

  function emitTerminalOnce(
    outcome: 'completed' | 'failed' | 'cancelled' | 'interrupted',
    exitCode: number | null,
    signal: string | null
  ): void {
    if (terminalEmitted) return
    terminalEmitted = true
    state = 'terminal'
    const assignmentId = armed?.assignmentId ?? ''
    emit({ type: 'terminal', assignmentId, outcome, exitCode, signal })
    // Flush the terminal message, then exit. The real entry defers the actual
    // process.exit so the queued parentPort message is delivered first; tests
    // inject a synchronous spy so the exit call is deterministic.
    exit(exitCode ?? 0)
  }

  function handleCancel(assignmentId: string): void {
    if (state === 'running') {
      emit({ type: 'cancel-ack', assignmentId })
      state = 'terminal'
      // Cooperative: the worker kills its Git child; the Job termination on the
      // main side is the guarantee, not this kill.
      const child = currentChild
      if (child) {
        try {
          child.kill('SIGKILL')
        } catch {
          /* already gone */
        }
      }
      emitTerminalOnce('cancelled', null, null)
    } else if (state === 'idle' || state === 'armed') {
      emit({ type: 'cancel-ack', assignmentId })
      emitTerminalOnce('cancelled', null, null)
    }
  }

  let currentChild: GitChildLike | null = null

  function handleCommand(command: CloneCommand): void {
    if (state === 'terminal') {
      // Terminal is a final state: ignore further commands.
      return
    }
    switch (command.type) {
      case 'arm': {
        if (state !== 'idle') {
          refuse(command.assignmentId, 'early-start', `arm received while worker is ${state}`)
          return
        }
        if (!isCloneEnvelope(command.envelope)) {
          refuse(command.assignmentId, 'tampered-envelope', 'envelope failed structural validation')
          return
        }
        if (command.envelope.assignmentId !== command.assignmentId) {
          refuse(
            command.assignmentId,
            'tampered-envelope',
            'envelope assignmentId does not match arm'
          )
          return
        }
        const actualHash = hashEnvelope(command.envelope)
        if (actualHash !== command.envelopeHash) {
          refuse(
            command.assignmentId,
            'tampered-envelope',
            `envelope hash mismatch: expected ${command.envelopeHash}, got ${actualHash}`
          )
          return
        }
        armed = {
          assignmentId: command.assignmentId,
          envelope: command.envelope,
          envelopeHash: command.envelopeHash
        }
        state = 'armed'
        emit({ type: 'armed', assignmentId: command.assignmentId })
        return
      }
      case 'start': {
        if (state !== 'armed' || armed === null) {
          refuse(
            command.assignmentId,
            state === 'idle' ? 'missing-envelope' : 'early-start',
            `start received while worker is ${state}`
          )
          return
        }
        if (armed.assignmentId !== command.assignmentId) {
          refuse(
            command.assignmentId,
            'unknown-assignment',
            `start for ${command.assignmentId} does not match armed assignment ${armed.assignmentId}`
          )
          return
        }
        const child = spawnGit(armed.envelope)
        currentChild = child
        state = 'running'
        emit({ type: 'started', assignmentId: command.assignmentId, gitPid: child.pid ?? -1 })
        wireChildOutput(child, armed.assignmentId)
        child.on('exit', (code, signal) => {
          currentChild = null
          if (state !== 'terminal') {
            emitTerminalOnce(code === 0 ? 'completed' : 'failed', code, signal)
          }
        })
        return
      }
      case 'cancel': {
        handleCancel(command.assignmentId)
        return
      }
    }
  }

  function wireChildOutput(child: GitChildLike, assignmentId: string): void {
    const forward = (chunk: Buffer | string): void => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
      const lines = text.split(/\r?\n/)
      for (const rawLine of lines) {
        if (rawLine.length === 0) continue
        const line = rawLine.length > maxLogLine ? `${rawLine.slice(0, maxLogLine)}…` : rawLine
        emit({ type: 'log', assignmentId, line })
        const match = PROGRESS_RE.exec(line)
        if (match && match[1]) {
          const phaseEntry = PROGRESS_PHASES.find((p) => p.match.test(rawLine))
          const percent = Math.min(100, Math.max(0, Number.parseInt(match[1] ?? '0', 10)))
          emit({
            type: 'progress',
            assignmentId,
            phase: phaseEntry?.phase ?? 'unknown',
            percent,
            detail: line
          })
        }
      }
    }
    child.stderr?.on('data', (chunk) => forward(chunk))
    child.stdout?.on('data', (chunk) => forward(chunk))
  }

  function start(): void {
    emit({ type: 'ready', pid: getPid() })
    port.onMessage(handleCommand)
  }

  return { start }
}

// ---------------------------------------------------------------------------
// Entry bootstrap — runs only inside a real Electron utility process (the
// bundler emits out/main/clone-worker.mjs; vitest imports the factory above).
// process.parentPort exists only in utility processes, so plain-Node imports
// (tests, QA bundles) never trigger this.
// ---------------------------------------------------------------------------
function isUtilityProcess(): boolean {
  return typeof process !== 'undefined' && 'parentPort' in process && process.parentPort !== null
}

function runAsUtilityProcess(): void {
  const parentPort = process.parentPort
  const port: CloneWorkerPort = {
    postMessage: (event) => parentPort.postMessage(event),
    onMessage: (listener) =>
      parentPort.on('message', (event) => listener(event.data as CloneCommand))
  }
  const worker = createCloneWorker({
    port,
    spawnGit: (envelope) =>
      spawn(envelope.git, envelope.argv, {
        cwd: envelope.cwd,
        env: { ...process.env, ...envelope.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      }),
    // Defer process.exit briefly so the queued terminal postMessage is flushed
    // to the parent before the process dies. Never use a long delay here.
    exit: (code) => {
      setTimeout(() => process.exit(code ?? 0), 50)
    }
  })
  worker.start()
}

if (isUtilityProcess()) {
  runAsUtilityProcess()
}
