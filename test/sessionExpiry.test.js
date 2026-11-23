import './env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

// This file checks session expiry, not limits: no upload limit (set before the app loads below).
process.env.RATE_LIMIT_UPLOADS_PER_HOUR = '0';

let server;
let base;
let store;
let config;
before(async () => {
  const { default: app } = await import('../src/app.js');
  store = await import('../src/services/vectorStore.js');
  ({ default: config } = await import('../src/config.js'));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));

const GONE = 'docchat_sid=11111111-2222-3333-4444-555555555555';
const getDocs = (cookie) => fetch(`${base}/api/documents`, { headers: cookie ? { cookie } : {} });
const ask = (cookie) => fetch(`${base}/api/chat`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', cookie },
  body: JSON.stringify({ question: 'Hello?' }),
});
async function uploadCookie() {
  const body = new FormData();
  body.append('files', new Blob(['Doors open at 8 am.'], { type: 'text/plain' }), 'doors.txt');
  const response = await fetch(`${base}/api/documents`, { method: 'POST', body });
  return response.headers.get('set-cookie').split(';')[0];
}

test('a new visitor (no cookie) is not told their session expired', async () => {
  const data = await (await getDocs()).json();
  assert.equal(data.sessionExpired, false);
});

test('a cookie for a session the server no longer has is reported as expired, and cleared', async () => {
  const response = await getDocs(GONE);
  const data = await response.json();
  assert.equal(data.sessionExpired, true);
  assert.deepEqual(data.documents, []);
  assert.match(response.headers.get('set-cookie') ?? '', /docchat_sid=;.*Expires=Thu, 01 Jan 1970/i);
});

test('a malformed cookie is ignored, not reported as expired', async () => {
  const data = await (await getDocs('docchat_sid=junk')).json();
  assert.equal(data.sessionExpired, false);
});

test('a live session is not expired', async () => {
  const cookie = await uploadCookie();
  const data = await (await getDocs(cookie)).json();
  assert.equal(data.sessionExpired, false);
  assert.equal(data.documents.length, 1);
});

test('after the idle time limit, the documents list and chat both say the session expired', async () => {
  const cookie = await uploadCookie();
  store.removeExpiredSessions(Date.now() + (config.sessionTtlMinutes + 1) * 60 * 1000);

  const chat = await ask(cookie);
  assert.equal(chat.status, 410);
  const body = await chat.json();
  assert.equal(body.code, 'SESSION_EXPIRED');
  assert.ok(body.error.includes(`removed after ${config.sessionTtlMinutes} minutes without activity`));
  assert.match(body.error, /[Uu]pload/);

  assert.equal((await (await getDocs(cookie)).json()).sessionExpired, true);
});

test('uploading with an expired cookie starts a new session that works', async () => {
  const body = new FormData();
  body.append('files', new Blob(['Gym opens at 6 am.'], { type: 'text/plain' }), 'gym.txt');
  const response = await fetch(`${base}/api/documents`, { method: 'POST', body, headers: { cookie: GONE } });
  assert.equal(response.status, 201);
  // The stale cookie is cleared first, then the new one is set (browsers apply them in order).
  const cookies = response.headers.getSetCookie();
  assert.match(cookies.at(-1), /^docchat_sid=[0-9a-f-]{36};/);
  const fresh = cookies.at(-1).split(';')[0];
  const data = await (await getDocs(fresh)).json();
  assert.deepEqual(data.documents.map((d) => d.name), ['gym.txt']);
  assert.equal(data.sessionExpired, false);
});

test('an upload with an expired cookie tells the page the old session expired', async () => {
  const body = new FormData();
  body.append('files', new Blob(['Pool opens at 7 am.'], { type: 'text/plain' }), 'pool.txt');
  const response = await fetch(`${base}/api/documents`, { method: 'POST', body, headers: { cookie: GONE } });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).sessionExpired, true);
});

test('a failed upload with an expired cookie also says the session expired', async () => {
  const body = new FormData();
  body.append('files', new Blob(['   '], { type: 'text/plain' }), 'blank.txt');
  const response = await fetch(`${base}/api/documents`, { method: 'POST', body, headers: { cookie: GONE } });
  assert.equal(response.status, 422);
  assert.equal((await response.json()).sessionExpired, true);
});

test('a normal upload does not say the session expired', async () => {
  const cookie = await uploadCookie();
  const body = new FormData();
  body.append('files', new Blob(['Bus leaves at 5 pm.'], { type: 'text/plain' }), 'bus.txt');
  const response = await fetch(`${base}/api/documents`, { method: 'POST', body, headers: { cookie } });
  assert.equal((await response.json()).sessionExpired, false);
});
