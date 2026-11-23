import './env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

// Running without a proxy in front: X-Forwarded-For must be ignored, or anyone could pick their own key.
process.env.TRUST_PROXY = 'false';

let server;
let base;
let config;
before(async () => {
  const { default: app } = await import('../src/app.js');
  ({ default: config } = await import('../src/config.js'));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));

test('TRUST_PROXY=false is read as "no proxy"', () => {
  assert.equal(config.trustProxy, false);
});

test('with TRUST_PROXY=false, a rotating X-Forwarded-For cannot get around the limit', async () => {
  const statuses = [];
  for (let i = 0; i <= config.chatPerMinute; i += 1) {
    const response = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `9.9.9.${i}` },
      body: JSON.stringify({ question: 'Hello?' }),
    });
    statuses.push(response.status);
  }
  assert.equal(statuses.at(-1), 429);
});
