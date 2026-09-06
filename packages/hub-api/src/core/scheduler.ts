function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Concurrency cap and minimum request-start gap for one Hub transport. */
export class RequestScheduler {
  private active = 0
  private nextStartAt = 0
  private readonly slotWaiters: Array<() => void> = []

  constructor(
    private readonly maxConcurrent: number,
    private readonly minRequestGapMs: number
  ) {}

  async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquireSlot()
    try {
      return await operation()
    } finally {
      this.releaseSlot()
    }
  }

  private async acquireSlot(): Promise<void> {
    while (this.active >= this.maxConcurrent) {
      await new Promise<void>((resolve) => this.slotWaiters.push(resolve))
    }
    this.active += 1
    const startAt = Math.max(Date.now(), this.nextStartAt)
    this.nextStartAt = startAt + this.minRequestGapMs
    const delay = startAt - Date.now()
    if (delay > 0) await sleep(delay)
  }

  private releaseSlot(): void {
    this.active -= 1
    this.slotWaiters.shift()?.()
  }
}
