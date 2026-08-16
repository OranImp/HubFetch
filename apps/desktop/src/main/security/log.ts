/**
 * RedactedLogger — the single console seam for the main process (plan Todo 22).
 *
 * Every main-process log site goes through `logger` so NO unredacted secret
 * can reach stdout/stderr: the message and every detail argument are run
 * through the shared `redactor` (which consults the shared `secretRegistry`)
 * before the console call. Errors render as redacted cause chains; structured
 * details render as redacted JSON-safe values.
 */
import { Redactor } from './redaction'
import { secretRegistry } from './secret-registry'

/** Process-wide redactor wired to the process-wide secret registry. */
export const redactor = new Redactor(secretRegistry)

export class RedactedLogger {
  constructor(private readonly renderer: Redactor = redactor) {}

  warn(scope: string, message: string, ...details: unknown[]): void {
    console.warn(this.prefix(scope, message), ...details.map((detail) => this.render(detail)))
  }

  error(scope: string, message: string, ...details: unknown[]): void {
    console.error(this.prefix(scope, message), ...details.map((detail) => this.render(detail)))
  }

  info(scope: string, message: string, ...details: unknown[]): void {
    console.info(this.prefix(scope, message), ...details.map((detail) => this.render(detail)))
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
