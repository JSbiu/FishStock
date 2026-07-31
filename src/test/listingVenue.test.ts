import assert from 'node:assert/strict';
import test from 'node:test';
import { listingVenue } from '../domain/listingVenue';

test('describes A-share and Hong Kong listing boards', () => {
  assert.equal(listingVenue('600519.SH'), '上交所');
  assert.equal(listingVenue('000333.SZ'), '深交所');
  assert.equal(listingVenue('300750.SZ'), '创业板');
  assert.equal(listingVenue('688981.SH'), '科创板');
  assert.equal(listingVenue('920189.BJ'), '北交所');
  assert.equal(listingVenue('00700.HK'), '港交所');
});

test('does not label indices or futures as listing boards', () => {
  assert.equal(listingVenue('000001.SHI'), undefined);
  assert.equal(listingVenue('AL0.CNF'), undefined);
});
