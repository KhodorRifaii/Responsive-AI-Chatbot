import './env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from '../src/middleware/rateLimit.js';

/** Run the middleware once and return the error it passed on (or null) and the headers it set. */
function hit(limiter, ip = '1.2.3.4') {
  const headers = {};
  let result;
  limiter({ ip }, { set: (name, value) => { headers[name] = value; } }, (error) => { result = error ?? null; });
  return { error: result, headers };
}

test('allows up to max requests per window, then answers 429 with Retry-After', () => {
  let now = 0;
  const limiter = createRateLimiter({ max: 2, windowMs: 60000, action: 'questions', now: () => now });
  assert.equal(hit(limiter).error, null);
  assert.equal(hit(limiter).headers['RateLimit-Remaining'], '0');
  now = 15000;
  const { error, headers } = hit(limiter);
  assert.equal(error.status, 429);
  assert.equal(error.code, 'RATE_LIMITED');
  assert.equal(headers['Retry-After'], '45');
  assert.match(error.message, /questions too fast\. Please wait 45 seconds/);
});

test('the limit resets when the window ends', () => {
  let now = 0;
  const limiter = createRateLimiter({ max: 1, windowMs: 60000, action: 'questions', now: () => now });
  hit(limiter);
  assert.equal(hit(limiter).error.status, 429);
  now = 60000;
  assert.equal(hit(limiter).error, null);
});

test('each visitor (IP) has their own count', () => {
  const limiter = createRateLimiter({ max: 1, windowMs: 60000, action: 'uploads' });
  assert.equal(hit(limiter, '10.0.0.1').error, null);
  assert.equal(hit(limiter, '10.0.0.2').error, null);
  assert.equal(hit(limiter, '10.0.0.1').error.status, 429);
});

test('long waits are shown in minutes or hours', () => {
  const limiter = createRateLimiter({ max: 1, windowMs: 3600000, action: 'uploads', now: () => 0 });
  hit(limiter);
  assert.match(hit(limiter).error.message, /uploads too fast\. Please wait 1 hour/);
});

test('max 0 turns the limit off', () => {
  const limiter = createRateLimiter({ max: 0, windowMs: 60000, action: 'questions' });
  for (let i = 0; i < 5; i += 1) assert.equal(hit(limiter).error, null);
  assert.equal(limiter.size(), 0);
});
