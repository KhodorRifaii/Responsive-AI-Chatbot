import './env.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createRateLimiter } from '../src/middleware/rateLimit.js';

const servers = [];
after(() => Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve)))));

/** A tiny app with one limited route, behind `trustProxy` proxies. Returns a function that calls it. */
async function limitedApp(options, trustProxy = 1) {
  const app = express();
  app.set('trust proxy', trustProxy);
  app.post('/limited', createRateLimiter(options), (req, res) => res.json({ ok: true }));
  app.use((error, req, res, next) => res.status(error.status).json({ error: error.message, code: error.code }));
  const server = app.listen(0);
  servers.push(server);
  await new Promise((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/limited`;
  return (ip) => fetch(url, { method: 'POST', headers: ip ? { 'X-Forwarded-For': ip } : {} });
}

test('allows up to max requests, then a friendly 429 with Retry-After', async () => {
  const call = await limitedApp({ max: 2, windowMs: 60000, action: 'questions' });
  assert.equal((await call('1.2.3.4')).status, 200);
  assert.equal((await call('1.2.3.4')).status, 200);
  const blocked = await call('1.2.3.4');
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  const body = await blocked.json();
  assert.equal(body.code, 'RATE_LIMITED');
  assert.match(body.error, /questions too fast\. Please wait (1 minute|\d+ seconds)/);
});

test('each visitor (IP) has their own count', async () => {
  const call = await limitedApp({ max: 1, windowMs: 60000, action: 'uploads' });
  assert.equal((await call('10.0.0.1')).status, 200);
  assert.equal((await call('10.0.0.2')).status, 200);
  assert.equal((await call('10.0.0.1')).status, 429);
});

test('IPv6 addresses in the same /64 share one count', async () => {
  const call = await limitedApp({ max: 2, windowMs: 60000, action: 'questions' });
  assert.equal((await call('2001:db8:1:1::1')).status, 200);
  assert.equal((await call('2001:db8:1:1::2')).status, 200);
  assert.equal((await call('2001:db8:1:1:ffff::3')).status, 429);
  assert.equal((await call('2001:db8:1:2::1')).status, 200); // another /64
});

test('a flood of new IPs does not reset a limited visitor', async () => {
  const call = await limitedApp({ max: 1, windowMs: 60000, action: 'questions' });
  await call('9.9.9.9');
  assert.equal((await call('9.9.9.9')).status, 429);
  for (let batch = 0; batch < 101; batch += 1) {
    await Promise.all(Array.from({ length: 100 }, (_, i) => call(`10.${batch}.${Math.floor(i / 250)}.${i % 250}`)));
  }
  assert.equal((await call('9.9.9.9')).status, 429);
});

test('long waits are shown in minutes or hours', async () => {
  const call = await limitedApp({ max: 1, windowMs: 3600000, action: 'uploads' });
  await call('5.5.5.5');
  assert.match((await (await call('5.5.5.5')).json()).error, /uploads too fast\. Please wait 1 hour/);
});

test('max 0 turns the limit off', async () => {
  const call = await limitedApp({ max: 0, windowMs: 60000, action: 'questions' });
  for (let i = 0; i < 5; i += 1) assert.equal((await call('6.6.6.6')).status, 200);
});
