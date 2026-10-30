import type { Quote } from './models';

export type QuoteDisplayKind =
  | 'unavailable'
  | 'suspended'
  | 'stale'
  | 'closed'
  | 'live';

/**
 * 停牌时行情源仍可能返回有效价格和 live 状态，因此展示状态不能直接取 state。
 * 停牌是比实时、休市、过期更具体的事实，所有界面共用这一优先级。
 */
export function quoteDisplayKind(quote: Quote | undefined): QuoteDisplayKind {
  if (!quote || quote.state === 'error') {
    return 'unavailable';
  }
  if (quote.suspended === true) {
    return 'suspended';
  }
  return quote.state;
}
