/**
 * Bounded main/renderer log capture (plan Todo 24).
 *
 * The support bundle's `logs/main.log` and `logs/renderer.log` members need
 * real, bounded, redacted log content. This module provides two bounded ring
 * buffers (main-process logger output and renderer console output), each
 * capped at the support-bundle log budget, persisted as UTF-8 text to
 * `userData/logs/`. Main lines are already redacted by `RedactedLogger`;
 * renderer console lines are redacted + path-sanitized at the capture
 * boundary, so neither the on-disk files nor the bundle members carry secrets.
 */
import { appendFile, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { sanitizePathText } from './diagnostics-env'
import { redactor } from './security/log'

/** Per-log member budget in the support bundle (also the capture cap). */
export const MAX_CAPTURE_BYTES = 1 << 20

/** Tracks the newest bytes of one log stream in memory and on disk. */
export class LogCapture {
  private readonly name: string
  private readonly dir: string
  private readonly maxBytes: number
  private buffer = ''
  private writes: Promise<void> = Promise.resolve()

  constructor(name: string, dir: string, maxBytes: number = MAX_CAPTURE_BYTES) {
    this.name = name
    this.dir = dir
    this.maxBytes = maxBytes
  }

  /**
   * Append one already-redacted line. The in-memory ring keeps only the newest
   * `maxBytes`; the disk file is appended to (serialized through `writes`) and
   * trimmed by a full rewrite once it outgrows the budget. A failed disk write
   * is swallowed so log capture never crashes the main process — the in-memory
   * ring keeps the bundle member correct regardless.
   */
  append(line: string): void {
    const text = line.endsWith('\n') ? line : `${line}\n`
    this.buffer += text
    if (Buffer.byteLength(this.buffer, 'utf8') > this.maxBytes) {
      this.buffer = trimToBudget(this.buffer, this.maxBytes)
    }
    this.writes = this.writes
      .then(async () => {
        await mkdir(this.dir, { recursive: true })
        await appendFile(this.filePath(), text, 'utf8')
      })
      .catch(() => undefined)
  }

  /** Current in-memory content (already bounded and redacted). */
  read(): string {
    return this.buffer
  }

  /** Trim the on-disk file to the budget; returns the new file size. */
  async flush(): Promise<number> {
    await this.writes
    try {
      const entry = await stat(this.filePath())
      if (entry.size <= this.maxBytes) return entry.size
      await this.rewrite()
    } catch {
      /* file not written yet — nothing to trim */
    }
    try {
      return (await stat(this.filePath())).size
    } catch {
      return 0
    }
  }

  private async rewrite(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const tmp = `${this.filePath()}.tmp`
    await writeFile(tmp, this.buffer, 'utf8')
    await rm(this.filePath(), { force: true })
    try {
      await rename(tmp, this.filePath())
    } catch {
      await rm(tmp, { force: true })
    }
  }

  private filePath(): string {
    return join(this.dir, this.name)
  }
}

/**
 * Keep the newest whole lines that fit within `budget` bytes. If a single line
 * exceeds the budget, the tail of that line is kept (never a truncated head).
 */
export function trimToBudget(text: string, budget: number): string {
  let start = text.length
  while (start > 0) {
    const candidate = text.slice(start)
    if (Buffer.byteLength(candidate, 'utf8') > budget) break
    const prev = text.lastIndexOf('\n', start - 1)
    if (prev < 0) break
    start = prev + 1
  }
  let out = text.slice(start)
  if (Buffer.byteLength(out, 'utf8') > budget) out = out.slice(out.length - budget)
  return out
}

/** Shared captures for the running session (constructed once by main). */
export function createLogCaptures(userDataDir: string): { main: LogCapture; renderer: LogCapture } {
  const dir = join(userDataDir, 'logs')
  return {
    main: new LogCapture('main.log', dir),
    renderer: new LogCapture('renderer.log', dir)
  }
}

/** Redact + path-sanitize one renderer console line before capture. */
export function sanitizeRendererLine(line: string): string {
  return sanitizePathText(redactor.redactText(line))
}
