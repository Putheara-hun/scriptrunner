import test from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from '../lib/ratelimit.js';

test('allows up to max, then blocks within the window', () => {
  const limiter = createRateLimiter({ windowMs: 1000, max: 3 });
  assert.equal(limiter.check('a', 0).allowed, true);
  assert.equal(limiter.check('a', 100).allowed, true);
  assert.equal(limiter.check('a', 200).allowed, true);
  const fourth = limiter.check('a', 300);
  assert.equal(fourth.allowed, false);
  assert.equal(fourth.retryAfterMs, 700);
});

test('each key is counted on its own', () => {
  const limiter = createRateLimiter({ windowMs: 1000, max: 1 });
  assert.equal(limiter.check('a', 0).allowed, true);
  assert.equal(limiter.check('b', 0).allowed, true);
  assert.equal(limiter.check('a', 0).allowed, false);
});

test('the window resets once it passes', () => {
  const limiter = createRateLimiter({ windowMs: 1000, max: 1 });
  assert.equal(limiter.check('a', 0).allowed, true);
  assert.equal(limiter.check('a', 500).allowed, false);
  assert.equal(limiter.check('a', 1000).allowed, true);
});

test('prune drops windows that have passed', () => {
  const limiter = createRateLimiter({ windowMs: 1000, max: 5 });
  limiter.check('a', 0);
  limiter.check('b', 0);
  assert.equal(limiter.size, 2);
  limiter.prune(1500);
  assert.equal(limiter.size, 0);
});
