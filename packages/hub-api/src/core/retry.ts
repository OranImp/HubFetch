import { HubApiError } from '../errors'

const RETRY_AFTER_CAP_MS = 60_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Retry-After parsing and capped full-jitter exponential backoff. */
export class RetryPolicy {
  constructor(private readonly maxRetries: number) {}

  shouldRetry(status: number, attempt: number, statuses: readonly number[]): boolean {
    return statuses.includes(status) && attempt < this.maxRetries
  }

  async wait(header: string | null, attempt: number): Promise<void> {
    let delay: number | undefined
    if (header) {
      const seconds = Number(header)
      if (Number.isFinite(seconds)) {
        delay = Math.min(Math.max(seconds, 0) * 1000, RETRY_AFTER_CAP_MS)
      } else {
        const date = Date.parse(header)
        if (!Number.isNaN(date))
          delay = Math.min(Math.max(date - Date.now(), 0), RETRY_AFTER_CAP_MS)
      }
    }
    await sleep(delay ?? Math.min(Math.random() * 1000 * 2 ** attempt, RETRY_AFTER_CAP_MS))
  }
}

/** Expired GET entries may mask network errors and 429/503 responses only. */
export function isTransientFailure(error: unknown): boolean {
  if (!(error instanceof HubApiError)) return true
  return error.status === 429 || error.status === 503
}
