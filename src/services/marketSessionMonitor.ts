import type { Disposable } from 'vscode';
import type { MarketSession, NormalizedSymbol } from '../domain/models';

export interface MarketSessionTransition {
  opened: NormalizedSymbol[];
  closed: NormalizedSymbol[];
}

type SessionResolver = (symbol: NormalizedSymbol, now: Date) => MarketSession;

export interface SessionSnapshot {
  symbols: Map<string, NormalizedSymbol>;
  open: ReadonlySet<string>;
  nextTransitionAt?: number;
}

const MAX_TIMER_DELAY_MS = 2_147_000_000;

export function marketSessionSnapshot(
  symbols: readonly NormalizedSymbol[],
  sessionFor: SessionResolver,
  now: Date,
): SessionSnapshot {
  const unique = new Map(symbols.map((symbol) => [symbol.symbol, symbol]));
  const open = new Set<string>();
  let nextTransitionAt: number | undefined;
  for (const symbol of unique.values()) {
    const session = sessionFor(symbol, now);
    if (session.phase === 'trading') {
      open.add(symbol.symbol);
    }
    if (
      session.nextTransitionAt !== undefined &&
      session.nextTransitionAt > now.getTime() &&
      (nextTransitionAt === undefined || session.nextTransitionAt < nextTransitionAt)
    ) {
      nextTransitionAt = session.nextTransitionAt;
    }
  }
  return { symbols: unique, open, nextTransitionAt };
}

export function compareSessionSnapshots(
  previous: ReadonlySet<string>,
  current: SessionSnapshot,
): MarketSessionTransition {
  return {
    opened: [...current.open]
      .filter((symbol) => !previous.has(symbol))
      .flatMap((symbol) => {
        const item = current.symbols.get(symbol);
        return item ? [item] : [];
      }),
    closed: [...previous]
      .filter((symbol) => !current.open.has(symbol))
      .flatMap((symbol) => {
        const item = current.symbols.get(symbol);
        return item ? [item] : [];
      }),
  };
}

export class MarketSessionMonitor implements Disposable {
  private timer: NodeJS.Timeout | undefined;
  private open: ReadonlySet<string> = new Set();
  private started = false;
  private disposed = false;

  public constructor(
    private readonly symbols: () => readonly NormalizedSymbol[],
    private readonly sessionFor: SessionResolver,
    private readonly onTransition: (
      transition: MarketSessionTransition,
    ) => Promise<void> | void,
    private readonly onError: (error: unknown) => void = () => undefined,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public start(): void {
    this.started = true;
    this.refresh();
  }

  public refresh(): void {
    if (this.disposed) {
      return;
    }
    this.clearTimer();
    const current = marketSessionSnapshot(this.symbols(), this.sessionFor, this.now());
    this.open = current.open;
    if (this.started) {
      this.schedule(current.nextTransitionAt);
    }
  }

  public dispose(): void {
    this.disposed = true;
    this.clearTimer();
  }

  private schedule(nextTransitionAt: number | undefined): void {
    this.clearTimer();
    if (nextTransitionAt === undefined || this.disposed) {
      return;
    }
    const delay = Math.min(
      Math.max(nextTransitionAt - this.now().getTime() + 50, 1),
      MAX_TIMER_DELAY_MS,
    );
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.handleTransition().catch(this.onError);
    }, delay);
  }

  private async handleTransition(): Promise<void> {
    if (this.disposed) {
      return;
    }
    const current = marketSessionSnapshot(this.symbols(), this.sessionFor, this.now());
    const transition = compareSessionSnapshots(this.open, current);
    this.open = current.open;
    try {
      await this.onTransition(transition);
    } finally {
      this.refresh();
    }
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
