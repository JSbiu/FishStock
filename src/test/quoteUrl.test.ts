import assert from 'node:assert/strict';
import test from 'node:test';
import { buildQuoteUrl } from '../domain/quoteUrl';

test('builds East Money URLs for A-shares by exchange', () => {
  assert.equal(buildQuoteUrl('600519.SH'), 'https://quote.eastmoney.com/sh600519.html');
  assert.equal(buildQuoteUrl('000001.SZ'), 'https://quote.eastmoney.com/sz000001.html');
  assert.equal(buildQuoteUrl('920189.BJ'), 'https://quote.eastmoney.com/bj920189.html');
  assert.equal(buildQuoteUrl('600519'), 'https://quote.eastmoney.com/sh600519.html');
});

test('builds East Money URLs for market indices', () => {
  assert.equal(buildQuoteUrl('000001.SHI'), 'https://quote.eastmoney.com/zs000001.html');
  assert.equal(buildQuoteUrl('399001.SZI'), 'https://quote.eastmoney.com/zs399001.html');
});

test('builds East Money URLs for Hong Kong stocks and Tencent URLs for Hong Kong indices', () => {
  assert.equal(buildQuoteUrl('00700.HK'), 'https://quote.eastmoney.com/hk/00700.html');
  assert.equal(buildQuoteUrl('00700'), 'https://quote.eastmoney.com/hk/00700.html');
  assert.equal(buildQuoteUrl('HSI.HKI'), 'https://gu.qq.com/hkHSI');
});

test('builds Sina URLs for futures main and month contracts', () => {
  assert.equal(buildQuoteUrl('AU0.CNF'), 'https://finance.sina.com.cn/futures/quotes/AU0.shtml');
  assert.equal(buildQuoteUrl('AL2608.CNF'), 'https://finance.sina.com.cn/futures/quotes/AL2608.shtml');
});

test('returns undefined for unsupported or invalid symbols', () => {
  assert.equal(buildQuoteUrl('AAPL.US'), undefined);
  assert.equal(buildQuoteUrl(''), undefined);
  assert.equal(buildQuoteUrl('not a symbol'), undefined);
});
