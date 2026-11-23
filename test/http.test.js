import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

// No key: these tests never call Gemini. Low limits so rate limiting is quick to check.
Object.assign(process.env, { GOOGLE_API_KEY: '', RATE_LIMIT_CHAT_PER_MINUTE: '3', RATE_LIMIT_UPLOADS_PER_HOUR: '3' });

let server;
let base;
before(async () => {
  const { default: app } = await import('../src/app.js');
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));

function upload(name, text, cookie) {
  const body = new FormData();
  body.append('files', new Blob([text], { type: 'text/plain' }), name);
  return fetch(`${base}/api/documents`, { method: 'POST', body, headers: cookie ? { cookie } : {} });
}
const cookieOf = (response) => response.headers.get('set-cookie')?.split(';')[0];
const listDocs = async (cookie) => (await (await fetch(`${base}/api/documents`, { headers: cookie ? { cookie } : {} })).json()).documents;
const ask = (question, cookie) => fetch(`${base}/api/chat`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
  body: JSON.stringify({ question }),
});

test('an upload sets an httpOnly session cookie, and other visitors see nothing', async () => {
  const response = await upload('notes.txt', 'The meeting is on Monday.');
  assert.equal(response.status, 201);
  const setCookie = response.headers.get('set-cookie');
  assert.match(setCookie, /docchat_sid=[0-9a-f-]{36}/);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Lax/i);

  const cookie = cookieOf(response);
  assert.deepEqual((await listDocs(cookie)).map((d) => d.name), ['notes.txt']);
  assert.deepEqual(await listDocs(), []);
  assert.deepEqual(await listDocs('docchat_sid=00000000-0000-0000-0000-000000000000'), []);
  assert.deepEqual(await listDocs('docchat_sid=../../etc'), []);
});

test('API errors are JSON with a code', async () => {
  const unknown = await fetch(`${base}/api/nope`);
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).code, 'NOT_FOUND');

  const bad = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' });
  assert.equal((await bad.json()).code, 'BAD_JSON');

  const unsupported = await upload('photo.png', 'x');
  assert.equal(unsupported.status, 415);
  assert.equal((await unsupported.json()).code, 'UNSUPPORTED_FILE');
});

test('questions over the per-minute limit get a friendly 429', async () => {
  const statuses = [];
  let last;
  for (let i = 0; i < 4; i += 1) {
    last = await ask('Hello?');
    statuses.push(last.status);
  }
  // NO_DOCUMENTS (400) for the first 3, then the limit of 3 per minute is reached.
  // (The BAD_JSON request above is rejected before the limiter, so it does not count.)
  assert.deepEqual(statuses, [400, 400, 400, 429]);
  assert.ok(Number(last.headers.get('retry-after')) > 0);
  const body = await last.json();
  assert.equal(body.code, 'RATE_LIMITED');
  assert.match(body.error, /too fast/);
});

test('health and document lists are not rate limited', async () => {
  for (let i = 0; i < 5; i += 1) assert.equal((await fetch(`${base}/api/health`)).status, 200);
  assert.equal((await fetch(`${base}/api/documents`)).status, 200);
});
