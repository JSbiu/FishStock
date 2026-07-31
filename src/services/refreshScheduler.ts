import type { Disposable } from 'vscode';

export class RefreshScheduler implements Disposable {
  private timer: NodeJS.Timeout | undefined;
  private active: Promise<void> | undefined;

  public constructor(
    private intervalMs: number,
    private readonly task: () => Promise<void>,
  ) {}

  public start(): void {
    this.configure(this.intervalMs);
  }

  public configure(intervalMs: number): void {
    this.intervalMs = intervalMs;
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.timer = setInterval(() => {
      void this.trigger();
    }, this.intervalMs);
  }

  public trigger(): Promise<void> {
    if (this.active) {
      return this.active;
    }
    this.active = this.task().finally(() => {
      this.active = undefined;
    });
    return this.active;
  }

  public dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
