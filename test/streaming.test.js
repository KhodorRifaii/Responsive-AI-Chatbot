import './env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { RunnableLambda } from '@langchain/core/runnables';

let rag;
let session;
let server;
let base;
before(async () => {
  rag = await import('../src/services/ragChain.js');
  const store = await import('../src/services/vectorStore.js');
  session = store.createSession();
  const text = 'Warranty: every product has a warranty of 18 months.';
  await store.addDocument(session, { originalname: 'policy.txt', buffer: Buffer.from(text), size: text.length });
  const { default: app } = await import('../src/app.js');
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));

/** Feed pieces through the filter; returns what would be shown while streaming. */
function shown(pieces) {
  const filter = rag.createSourcesFilter();
  return pieces.map((piece) => filter.push(piece)).join('');
}

test('the SOURCES line is never shown while streaming, wherever the pieces split', () => {
  assert.equal(shown(['18 months.\nSOU', 'RCES: 1']), '18 months.\n');
  assert.equal(shown(['18 months.\nSOURCES: 1\n']), '18 months.\n');
  assert.equal(shown(['18 months.\nSOURCES: 1', '\n']), '18 months.\n');
  assert.equal(shown(['18 months.\n**Sources:** 2']), '18 months.\n');
  assert.equal(shown(['18 months.\n*', '*Sour', 'ces:** 2']), '18 months.\n');
  assert.equal(shown(['18 months. SOURCES: 1']), '18 months. ');
  assert.equal(shown(['18 months.\nSOURCES: [1], ', '[3]']), '18 months.\n');
  assert.equal(shown(['18 months.\nSOURCES: 1 a', 'nd 3']), '18 months.\n');
  assert.equal(shown(['18 months.\nSOURCES: 1-3']), '18 months.\n');
});

test('ordinary text with the word "sources" is shown while streaming', () => {
  assert.equal(shown(['Sources of income: salary.\n', 'Next line.']), 'Sources of income: salary.\nNext line.');
  assert.equal(shown(['The sources are described ', 'in the appendix.']), 'The sources are described in the appendix.');
  assert.equal(shown(['Our sources: 2 suppliers ', 'deliver daily.']), 'Our sources: 2 suppliers deliver daily.');
  assert.equal(shown(['Sources']), '');
  assert.equal(shown(['SOURCES: 1\n', 'More text.']), 'SOURCES: 1\nMore text.');
  assert.equal(shown(['So the warranty is long.']), 'So the warranty is long.');
  assert.equal(shown(['It is ', 'So']), 'It is ');
});

// Stand-ins for a streaming Gemini model.
const streams = (...pieces) => RunnableLambda.from(async function* () {
  for (const piece of pieces) yield piece;
});
const failsAfter = (pieces, status) => RunnableLambda.from(async function* () {
  for (const piece of pieces) yield piece;
  throw Object.assign(new Error('The model is overloaded'), { status });
});
const failsAtOnce = (status) => failsAfter([], status);

const stream = async (llm, fallbackLlm) => {
  const tokens = [];
  const result = await rag.streamAnswer({ question: 'How long is the warranty?', session, llm, fallbackLlm, onToken: (t) => tokens.push(t) });
  return { tokens: tokens.join(''), result };
};

test('a streamed answer ends with the same answer and sources as the JSON answer', async () => {
  const { tokens, result } = await stream(streams('18 ', 'months.', '\nSOURCES: 1'));
  assert.equal(tokens, '18 months.\n');
  assert.equal(result.answer, '18 months.');
  assert.equal(result.sources[0].source, 'policy.txt');
});

test('the fallback model streams when the main model fails before the first token', async () => {
  const { tokens, result } = await stream(failsAtOnce(503), streams('18 months.\nSOURCES: 1'));
  assert.equal(result.answer, '18 months.');
  assert.equal(tokens, '18 months.\n');
});

test('no fallback once text was shown: the error ends the answer', async () => {
  let fallbackCalls = 0;
  const fallback = RunnableLambda.from(async () => {
    fallbackCalls += 1;
    return 'never used';
  });
  await assert.rejects(stream(failsAfter(['18 months'], 503), fallback), { code: 'LLM_BUSY' });
  assert.equal(fallbackCalls, 0);
});

test('a streamed request that fails before any token gets a plain JSON error', async () => {
  // No API key in tests: MISSING_API_KEY happens before the stream starts.
  const upload = new FormData();
  upload.append('files', new Blob(['The meeting is on Monday.'], { type: 'text/plain' }), 'notes.txt');
  const cookie = (await fetch(`${base}/api/documents`, { method: 'POST', body: upload })).headers.get('set-cookie').split(';')[0];
  const response = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson', cookie },
    body: JSON.stringify({ question: 'When is the meeting?' }),
  });
  assert.equal(response.status, 503);
  assert.match(response.headers.get('content-type'), /application\/json/);
  assert.equal((await response.json()).code, 'MISSING_API_KEY');
});
