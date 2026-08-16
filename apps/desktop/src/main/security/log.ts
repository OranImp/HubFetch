/**
 * RedactedLogger — the single console seam for the main process (plan Todo 22).
 *
 * Every main-process log site goes through `logger` so NO unredacted secret
 * can reach stdout/stderr: the message and every detail argument are run
 * through the shared `redactor` (which consults the shared `secretRegistry`)
 * before the console call. Errors render as redacted cause chains; structured
 * details render as redacted JSON-safe values.
 *
 * Todo 24: the same redacted line is mirrored into the bounded main.log
 * capture (see log-capture.ts) so the support bundle carries it verbatim.
 */
import { Redactor } from './redaction'
import { secretRegistry } from './secret-registry'
import type { LogCapture } from '../log-capture'

/** Process-wide redactor wired to the process-wide secret registry. */
export const redactor = new Redactor(secretRegistry)

export class RedactedLogger {
  private capture: LogCapture | null = null

  constructor(private readonly renderer: Redactor = redactor) {}

  /** Attach the bounded main.log capture; idempotent. */
  attach(capture: LogCapture | null): void {
    this.capture = capture
  }

  warn(scope: string, message: string, ...details: unknown[]): void {
    this.emit('warn', scope, message, details)
  }

  error(scope: string, message: string, ...details: unknown[]): void {
    this.emit('error', scope, message, details)
  }

  info(scope: string, message: string, ...details: unknown[]): void {
    this.emit('info', scope, message, details)
  }

  private emit(
    level: 'warn' | 'error' | 'info',
    scope: string,
    message: string,
    details: unknown[]
  ): void {
    const prefix = this.prefix(scope, message)
    const rendered = details.map((detail) => this.render(detail))
    // Console call shape is part of the Todo 22 contract: (prefix, ...details).
    console[level](prefix, ...rendered)
    const line = rendered.length === 0 ? prefix : `${prefix} ${rendered.join(' ')}`
    this.capture?.append(line)
  }

  private prefix(scope: string, message: string): string {
    return `[${scope}] ${this.renderer.redactText(message)}`
  }

  private render(detail: unknown): string {
    if (detail instanceof Error) return this.renderer.redactError(detail)
    if (typeof detail === 'string') return this.renderer.redactText(detail)
    try {
      return JSON.stringify(this.renderer.redactValue(detail)) ?? String(detail)
    } catch {
      return this.renderer.redactText(String(detail))
    }
  }
}

/** The shared main-process logger. */
export const logger = new RedactedLogger()
