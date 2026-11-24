// A wrong embedding setting is reported as a settings problem (EMBEDDING_CONFIG), a real load failure as a connectivity problem
// (EMBEDDING_FAILED) that names the setting too. Hermetic: the model is the default MiniLM from the cache (as in sessions.test.js).
import './env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

let server;
let base;
let store;
before(async () => {
  const { default: app } = await import('../src/app.js');
  store = await import('../src/services/vectorStore.js');
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));

function upload(name, text) {
  const body = new FormData();
  body.append('files', new Blob([text], { type: 'text/plain' }), name);
  return fetch(`${base}/api/documents`, { method: 'POST', body });
}

test('EMBEDDING_DIMENSIONS larger than the model gives: the upload says EMBEDDING_CONFIG and names the three settings, nothing is half-indexed', async (t) => {
  t.mock.method(console, 'error', () => {});
  t.mock.property(store.embeddings, 'profile', { ...store.embeddings.profile, dimensions: 9999 });
  const before = store.getStats().totalChunks;
  const response = await upload('doors.txt', 'Doors open at 8 am.');
  const body = await response.json();
  assert.equal(response.status, 422, 'the upload route reports a failed file as 422 with the file error inside');
  assert.equal(body.code, 'EMBEDDING_CONFIG');
  assert.match(body.error, /EMBEDDING_MODEL, EMBEDDING_POOLING and EMBEDDING_DIMENSIONS/);
  assert.match(body.error, /9999/);
  assert.doesNotMatch(body.error, /internet/i, 'not the connectivity message');
  assert.equal(store.getStats().totalChunks, before);
});

test('a real load failure keeps the connectivity message, and it names EMBEDDING_MODEL', async (t) => {
  t.mock.method(console, 'error', () => {});
  t.mock.method(store.embeddings, 'embedDocuments', async () => {
    throw new TypeError('fetch failed');
  });
  const body = await (await upload('doors.txt', 'Doors open at 8 am.')).json();
  assert.equal(body.code, 'EMBEDDING_FAILED');
  assert.match(body.error, /internet/i);
  assert.match(body.error, /EMBEDDING_MODEL/);
});

test('a missing sentence_embedding output is a settings problem, not an internet problem', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { EmbeddingConfigError } = await import('../src/services/embeddingErrors.js');
  t.mock.method(store.embeddings, 'embedDocuments', async () => {
    throw new EmbeddingConfigError('Embedding model x returned no sentence_embedding output, so pooling "model" cannot be used with it.');
  });
  const body = await (await upload('doors.txt', 'Doors open at 8 am.')).json();
  assert.equal(body.code, 'EMBEDDING_CONFIG');
  assert.match(body.error, /sentence_embedding/);
});

test('searching with a broken embedding setting also says EMBEDDING_CONFIG (a chat question after the setting was changed)', async (t) => {
  t.mock.method(console, 'error', () => {});
  const session = store.createSession();
  await store.addDocument(session, { originalname: 'a.txt', buffer: Buffer.from('Doors open at 8 am.'), size: 19 });
  t.mock.property(store.embeddings, 'profile', { ...store.embeddings.profile, dimensions: 9999 });
  await assert.rejects(store.search(session, 'When do doors open?'), (error) => {
    assert.equal(error.code, 'EMBEDDING_CONFIG');
    return true;
  });
});
