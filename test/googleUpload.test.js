// The upload and search paths with the hosted embedder: a failure half way through a document leaves nothing behind, and every
// kind of failure has its own code. Hermetic: GoogleEmbeddings with a scripted fake fetch is swapped in for the (local) default.
import './env.js';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { GoogleEmbeddings } from '../src/services/googleEmbeddings.js';
import { resolveEmbeddingProfile } from '../src/services/embeddingProfile.js';

let store;
before(async () => {
  store = await import('../src/services/vectorStore.js');
});

const profile = resolveEmbeddingProfile('gemini-embedding-2', { EMBEDDING_PROVIDER: 'google' });
const vector = (i) => Array.from({ length: 768 }, (_, k) => (k === i % 768 ? 1 : 0.001));
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ok = (call) => json(call.body.requests ? { embeddings: call.body.requests.map((_, i) => ({ values: vector(i) })) } : { embedding: { values: vector(0) } });
const failure = (status, reason, message = 'x') => json({ error: { code: status, status: 'X', message, details: reason ? [{ reason }] : [] } }, status);

/** Replaces the store's embedder by a GoogleEmbeddings on a scripted fetch; returns the calls made. */
function useGoogle(t, script) {
  const calls = [];
  const fetch = async (url, init) => {
    const call = { url: String(url), body: JSON.parse(init.body) };
    calls.push(call);
    const step = script[Math.min(calls.length - 1, script.length - 1)];
    return step(call);
  };
  const google = new GoogleEmbeddings({ apiKey: 'AIzaSyTESTTESTTESTTESTTESTTESTTESTTEST1', model: 'gemini-embedding-2', profile, fetch, sleep: async () => {}, random: () => 0 });
  t.mock.method(store.embeddings, 'embedDocuments', (texts) => google.embedDocuments(texts));
  t.mock.method(store.embeddings, 'embedQuery', (text) => google.embedQuery(text));
  t.mock.method(console, 'error', () => {});
  return calls;
}
const file = (name, text) => ({ originalname: name, buffer: Buffer.from(text), size: text.length });
// About 40 chunks: with 16 chunks per embedding step that is three steps, so there is a "middle" to fail in.
const longText = Array.from({ length: 40 }, (_, i) => `Part ${i}: ${'word '.repeat(190)}`).join('\n\n');
const rejectsWith = (promise, code) => assert.rejects(promise, (error) => {
  assert.equal(error.code, code);
  return true;
});

test('an upload with the hosted embedder: vectors of 768 values, searched with the query vector', async (t) => {
  const calls = useGoogle(t, [ok]);
  const session = store.createSession();
  const info = await store.addDocument(session, file('doors.txt', 'Doors open at 8 am.'));
  assert.equal(info.chunks, 1);
  assert.equal(session.store.memoryVectors[0].embedding.length, 768);
  const results = await store.search(session, 'When do doors open?');
  assert.equal(results.length, 1);
  assert.deepEqual(calls.map((c) => c.url.split(':').pop()), ['batchEmbedContents', 'embedContent']);
});

test('a failure in the middle of a long document adds nothing: no vectors, no document, the space is given back', async (t) => {
  // Step 1 (16 chunks) works, step 2 fails with a setting error: the 16 vectors of step 1 must not stay in the store.
  const calls = useGoogle(t, [ok, () => failure(400, null, 'Request contains an invalid argument.')]);
  const session = store.createSession();
  const before = store.getStats().totalChunks;
  await rejectsWith(store.addDocument(session, file('long.txt', longText)), 'EMBEDDING_CONFIG');
  assert.equal(calls.length, 2, 'it stopped at the failing step');
  assert.equal(session.store.memoryVectors.length, 0);
  assert.equal(session.documents.size, 0);
  assert.equal(session.chunks, 0);
  assert.equal(store.getStats().totalChunks, before);
  // The same session still works afterwards.
  t.mock.restoreAll();
  useGoogle(t, [ok]);
  assert.equal((await store.addDocument(session, file('again.txt', 'Short text.'))).chunks, 1);
});

test('each failure has its own code: key, quota, busy service, setting', async (t) => {
  const cases = [
    ['EMBEDDING_AUTH', () => failure(400, 'API_KEY_INVALID', 'API key not valid. Please pass a valid API key.')],
    ['EMBEDDING_RATE_LIMIT', () => failure(429, null, 'Resource has been exhausted')],
    ['EMBEDDING_FAILED', () => failure(503, null, 'The model is overloaded')],
    ['EMBEDDING_CONFIG', () => failure(404, null, 'models/x is not found')],
  ];
  for (const [code, respond] of cases) {
    t.mock.restoreAll();
    useGoogle(t, [respond]);
    const session = store.createSession();
    await rejectsWith(store.addDocument(session, file('a.txt', 'Some text.')), code);
    assert.equal(session.documents.size, 0, code);
  }
});

test('a quota error while searching (the visitor\'s question) is EMBEDDING_RATE_LIMIT, not "something went wrong"', async (t) => {
  useGoogle(t, [ok]);
  const session = store.createSession();
  await store.addDocument(session, file('a.txt', 'Doors open at 8 am.'));
  t.mock.restoreAll();
  useGoogle(t, [() => failure(429, null, 'quota')]);
  await rejectsWith(store.search(session, 'When?'), 'EMBEDDING_RATE_LIMIT');
});

test('the visitor closes the page during a long upload: no more embedding calls, the space is given back', async (t) => {
  const { default: app } = await import('../src/app.js');
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  t.mock.method(console, 'error', () => {});
  let steps = 0;
  // A slow embedder that honours the signal like GoogleEmbeddings does: 80 ms per step of 16 chunks.
  t.mock.method(store.embeddings, 'embedDocuments', async (texts, { signal } = {}) => {
    steps += 1;
    await new Promise((resolve) => setTimeout(resolve, 80));
    if (signal?.aborted) throw Object.assign(new Error('gone'), { code: 'CLIENT_GONE' });
    return texts.map((_, i) => vector(i));
  });
  const before = store.getStats().totalChunks;
  const client = new AbortController();
  const body = new FormData();
  body.append('files', new Blob([longText], { type: 'text/plain' }), 'long.txt');
  const request = fetch(`http://127.0.0.1:${server.address().port}/api/documents`, { method: 'POST', body, signal: client.signal }).catch(() => null);
  await new Promise((resolve) => setTimeout(resolve, 120));
  client.abort();
  await request;
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.ok(steps < 3, `embedding went on after the visitor left (${steps} steps; the whole document has 3)`);
  assert.equal(store.getStats().totalChunks, before, 'the reserved space is given back');
});
