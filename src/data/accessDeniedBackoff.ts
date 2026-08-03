const ACCESS_DENIED_BACKOFF_MS = [
  15 * 60 * 1_000,
  30 * 60 * 1_000,
  60 * 60 * 1_000,
  2 * 60 * 60 * 1_000,
  6 * 60 * 60 * 1_000,
] as const;

export class AccessDeniedBackoff {
  private failureCount = 0;
  private retryAt = 0;

  public constructor(private readonly now: () => Date) {}

  public canRetry(): boolean {
    return this.now().getTime() >= this.retryAt;
  }

  public getNextRetryAt(): Date | undefined {
    return this.canRetry() ? undefined : new Date(this.retryAt);
  }

  public recordFailure(): Date {
    const delay = ACCESS_DENIED_BACKOFF_MS[
      Math.min(this.failureCount, ACCESS_DENIED_BACKOFF_MS.length - 1)
    ];
    this.failureCount += 1;
    this.retryAt = this.now().getTime() + delay;
    return new Date(this.retryAt);
  }

  public reset(): void {
    this.failureCount = 0;
    this.retryAt = 0;
  }
}
