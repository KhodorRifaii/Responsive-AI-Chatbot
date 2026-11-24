import './env.js';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// Small limits so they are quick to reach. Set before the app's config is loaded (dynamic import below).
Object.assign(process.env, { MAX_SESSIONS: '3', MAX_CHUNKS_PER_SESSION: '4', MAX_TOTAL_CHUNKS: '6' });

let store;
let afterTtl;
before(async () => {
  store = await import('../src/services/vectorStore.js');
  const { default: config } = await import('../src/config.js');
  afterTtl = () => Date.now() + (config.sessionTtlMinutes + 1) * 60 * 1000;
});

const file = (name, text) => ({ originalname: name, buffer: Buffer.from(text), size: text.length });
const parts = (n) => Array.from({ length: n }, (_, i) => `Part ${i}: ${'word '.repeat(190)}`).join('\n\n');

async function rejectsWith(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

test('two sessions never see or search each other\'s documents', async () => {
  const alice = store.createSession();
  const bob = store.createSession();
  await store.addDocument(alice, file('alice.txt', 'The secret code for the vault is 4321.'));
  await store.addDocument(bob, file('bob.txt', 'Lunch is served at noon in the cafeteria.'));

  assert.deepEqual(store.listDocuments(alice).map((d) => d.name), ['alice.txt']);
  assert.deepEqual(store.listDocuments(bob).map((d) => d.name), ['bob.txt']);
  const results = await store.search(bob, 'What is the secret vault code?', 4);
  assert.ok(results.every(([chunk]) => chunk.metadata.source === 'bob.txt'));
  assert.equal(store.getSession(alice.id), alice);
  assert.equal(store.getSession('not-a-session'), null);
  assert.equal(store.hasDocuments(null), false);
});

test('per-session and global part limits give friendly errors and keep the counts right', async () => {
  const session = store.createSession();
  await rejectsWith(store.addDocument(session, file('big.txt', parts(5))), 'DOCUMENT_TOO_LARGE');
  assert.equal(session.chunks, 0);
  await store.addDocument(session, file('ok.txt', parts(2)));
  // Global limit is 6 parts: 2 from the first test, 2 here; 4 more does not fit.
  assert.equal(session.chunks, 2);
  assert.equal(store.getStats().totalChunks, 4);
});

test('expired sessions are removed and their parts are freed', async () => {
  const before = store.getStats();
  store.removeExpiredSessions(afterTtl());
  const after = store.getStats();
  assert.equal(after.sessions, 0);
  assert.equal(after.totalChunks, 0);
  assert.ok(before.sessions > 0);
});

test('too many sessions answers SERVER_BUSY, and a full server answers SERVER_BUSY on upload', async () => {
  const sessions = [store.createSession(), store.createSession(), store.createSession()];
  assert.throws(() => store.createSession(), (e) => e.code === 'SERVER_BUSY');
  await store.addDocument(sessions[0], file('a.txt', parts(4)));
  await rejectsWith(store.addDocument(sessions[1], file('b.txt', parts(3))), 'SERVER_BUSY');
  assert.equal(store.getStats().totalChunks, 4);
});

test('a session holds at most 10 documents', async () => {
  store.removeExpiredSessions(afterTtl());
  const session = store.createSession();
  session.documents = new Map(Array.from({ length: 10 }, (_, i) => [String(i), {}]));
  await rejectsWith(store.addDocument(session, file('eleven.txt', 'one more')), 'TOO_MANY_DOCUMENTS');
});

test('a session that expired during an upload reserves no more space', async () => {
  store.removeExpiredSessions(afterTtl());
  const session = store.createSession();
  store.removeExpiredSessions(afterTtl());
  const before = store.getStats().totalChunks;
  await rejectsWith(store.addDocument(session, file('late.txt', 'Late file.')), 'SESSION_EXPIRED');
  assert.equal(store.getStats().totalChunks, before);
});

test('a session that expires while embedding and then fails gives its space back only once', async (t) => {
  t.mock.method(console, 'error', () => {});
  store.removeExpiredSessions(afterTtl());
  const before = store.getStats().totalChunks;
  const session = store.createSession();
  // The slow step fails after the session was already freed by the expiry check.
  session.store.addVectors = async () => {
    store.removeExpiredSessions(afterTtl());
    throw new Error('embedding failed');
  };
  await rejectsWith(store.addDocument(session, file('slow.txt', 'Slow file.')), 'EMBEDDING_FAILED');
  assert.equal(store.getStats().totalChunks, before);
});
