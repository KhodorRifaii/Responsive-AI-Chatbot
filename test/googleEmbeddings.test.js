// Tests for the hosted Google embeddings client (src/services/googleEmbeddings.js). Hermetic: a scripted fake fetch, no key, no network,
// no waiting (sleep and the clock are injected).
import './env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GoogleEmbeddings } from '../src/services/googleEmbeddings.js';
import { resolveEmbeddingProfile } from '../src/services/embeddingProfile.js';
import { EmbeddingAuthError, EmbeddingConfigError, EmbeddingQuotaError, EmbeddingUnavailableError } from '../src/services/embeddingErrors.js';
import { HttpError } from '../src/utils/httpError.js';

const KEY = 'AIzaSyTESTTESTTESTTESTTESTTESTTESTTEST1';
const V2 = 'gemini-embedding-2';
const V1 = 'gemini-embedding-001';
const profile = (model, env = {}) => resolveEmbeddingProfile(model, { EMBEDDING_PROVIDER: 'google', ...env });

/** A vector of `length` values for text number i: not unit length, so the client must normalise. */
const vector = (length, i = 0) => Array.from({ length }, (_, k) => (k === 0 ? 3 + i : k === 1 ? 4 : 0));
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const googleError = (status, code, reason, message = 'something') => json({ error: { code, status: code === 400 ? 'INVALID_ARGUMENT' : 'X', message, details: reason ? [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason }] : [] } }, status);

/** A fake fetch. `script` is a list of responders (a Response, an Error to throw, or a function(call) -> Response) used in order; the last one repeats. */
function fakeFetch(script) {
  const calls = [];
  const fetch = async (url, init) => {
    const call = { url: String(url), headers: init.headers, body: JSON.parse(init.body), signal: init.signal };
    calls.push(call);
    const step = script[Math.min(calls.length - 1, script.length - 1)];
    const outcome = typeof step === 'function' ? await step(call) : step;
    if (outcome instanceof Error) throw outcome;
    return outcome.clone();
  };
  return { fetch, calls };
}
/** Answers a batch request with one vector per request, of the size that was asked for. */
const echoBatch = (call) => json({ embeddings: call.body.requests.map((_, i) => ({ values: vector(call.body.requests[i].outputDimensionality ?? 8, i) })) });
const echoOne = (call) => json({ embedding: { values: vector(call.body.outputDimensionality ?? 8) } });

function clock() {
  let now = 0;
  const waits = [];
  return { now: () => now, sleep: async (ms) => { waits.push(ms); now += ms; }, waits, advance: (ms) => { now += ms; } };
}
function client(model, script, extra = {}) {
  const { fetch, calls } = fakeFetch(script);
  const time = clock();
  const warnings = [];
  const embeddings = new GoogleEmbeddings({ apiKey: KEY, model, profile: profile(model), fetch, now: time.now, sleep: time.sleep, random: () => 0, warn: (line) => warnings.push(line), ...extra });
  return { embeddings, calls, time, warnings };
}
const norm = (v) => Math.hypot(...v);

test('gemini-embedding-2: a query is one embedContent call with the query prefix, no taskType, the key in a header (never in the URL), and the 768 size', async () => {
  const { embeddings, calls } = client(V2, [echoOne]);
  const vector768 = await embeddings.embedQuery('كم يوما؟');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://generativelanguage.googleapis.com/v1beta/models/${V2}:embedContent`);
  assert.equal(calls[0].headers['x-goog-api-key'], KEY);
  assert.doesNotMatch(calls[0].url, /key=|AIza/);
  assert.deepEqual(calls[0].body, { model: `models/${V2}`, content: { parts: [{ text: 'task: search result | query: كم يوما؟' }] }, outputDimensionality: 768 });
  assert.equal(vector768.length, 768);
  assert.ok(Math.abs(norm(vector768) - 1) < 1e-9, 'normalised');
});

test('gemini-embedding-2: documents go in batchEmbedContents with the document prefix and no taskType', async () => {
  const { embeddings, calls } = client(V2, [echoBatch]);
  const vectors = await embeddings.embedDocuments(['a', 'b']);
  assert.equal(calls[0].url, `https://generativelanguage.googleapis.com/v1beta/models/${V2}:batchEmbedContents`);
  assert.deepEqual(calls[0].body, { requests: [
    { model: `models/${V2}`, content: { parts: [{ text: 'title: none | text: a' }] }, outputDimensionality: 768 },
    { model: `models/${V2}`, content: { parts: [{ text: 'title: none | text: b' }] }, outputDimensionality: 768 },
  ] });
  assert.equal(vectors.length, 2);
  assert.notDeepEqual(vectors[0], vectors[1], 'one vector per text, in order');
});

test('gemini-embedding-001: task types RETRIEVAL_QUERY / RETRIEVAL_DOCUMENT and no prefix; the vector is normalised by the client', async () => {
  const { embeddings, calls } = client(V1, [echoOne, echoBatch]);
  const query = await embeddings.embedQuery('q');
  assert.equal(calls[0].body.taskType, 'RETRIEVAL_QUERY');
  assert.equal(calls[0].body.content.parts[0].text, 'q');
  assert.ok(Math.abs(norm(query) - 1) < 1e-9, 'Google does not normalise truncated gemini-embedding-001 vectors');
  await embeddings.embedDocuments(['d']);
  assert.equal(calls[1].body.requests[0].taskType, 'RETRIEVAL_DOCUMENT');
  assert.equal(calls[1].body.requests[0].content.parts[0].text, 'd');
});

test('EMBEDDING_DIMENSIONS is sent as outputDimensionality; an unlisted model sends no size, no prefix, no task type', async () => {
  const sized = client(V2, [echoOne], { profile: profile(V2, { EMBEDDING_DIMENSIONS: '256' }) });
  assert.equal((await sized.embeddings.embedQuery('q')).length, 256);
  assert.equal(sized.calls[0].body.outputDimensionality, 256);
  const plain = client('gemini-embedding-9', [echoOne], { profile: profile('gemini-embedding-9') });
  await plain.embeddings.embedQuery('q');
  assert.deepEqual(plain.calls[0].body, { model: 'models/gemini-embedding-9', content: { parts: [{ text: 'q' }] } });
});

test('batching: 40 texts are 3 calls of 16, 16 and 8, in order, and the vectors come back in order', async () => {
  const { embeddings, calls } = client(V2, [echoBatch]);
  const texts = Array.from({ length: 40 }, (_, i) => `text ${i}`);
  const vectors = await embeddings.embedDocuments(texts);
  assert.deepEqual(calls.map((c) => c.body.requests.length), [16, 16, 8]);
  assert.equal(vectors.length, 40);
  assert.equal(calls[2].body.requests[7].content.parts[0].text, 'title: none | text: text 39');
  assert.deepEqual(embeddings.stats.texts, 40);
  assert.equal(embeddings.stats.requests, 3);
  assert.deepEqual((await embeddings.embedDocuments([])), [], 'nothing to embed: no call');
  assert.equal(calls.length, 3);
});

test('429 then 200: one retry, the wait follows Retry-After (seconds), and a huge Retry-After is capped at 5 s', async () => {
  const withHeader = client(V2, [json({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota' } }, 429, { 'retry-after': '2' }), echoOne]);
  await withHeader.embeddings.embedQuery('q');
  assert.equal(withHeader.calls.length, 2);
  assert.deepEqual(withHeader.time.waits, [2000]);
  assert.equal(withHeader.embeddings.stats.retries, 1);
  const huge = client(V2, [json({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota' } }, 429, { 'retry-after': '3600' }), echoOne]);
  await huge.embeddings.embedQuery('q');
  assert.deepEqual(huge.time.waits, [5000]);
  // Without the header: exponential backoff from 500 ms.
  const plain = client(V2, [googleError(429, 429, null, 'quota'), echoOne]);
  await plain.embeddings.embedQuery('q');
  assert.deepEqual(plain.time.waits, [500]);
  assert.equal(plain.calls.length, 2);
});

test('429 forever: three attempts, then EmbeddingQuotaError (never an endless loop)', async () => {
  const { embeddings, calls, time } = client(V2, [googleError(429, 429, null, 'Resource has been exhausted')]);
  await assert.rejects(embeddings.embedQuery('q'), EmbeddingQuotaError);
  assert.equal(calls.length, 3);
  assert.deepEqual(time.waits, [500, 1000]);
});

test('503 and a network error are retried, then EmbeddingUnavailableError; 500/502/504 count the same', async () => {
  for (const status of [500, 502, 503, 504]) {
    const { embeddings, calls } = client(V2, [googleError(status, status, null)]);
    await assert.rejects(embeddings.embedQuery('q'), EmbeddingUnavailableError, String(status));
    assert.equal(calls.length, 3, String(status));
  }
  const net = client(V2, [new TypeError('fetch failed'), new TypeError('fetch failed'), echoOne]);
  assert.equal((await net.embeddings.embedQuery('q')).length, 768, 'two network errors, then success');
  const dead = client(V2, [new TypeError('fetch failed')]);
  await assert.rejects(dead.embeddings.embedQuery('q'), EmbeddingUnavailableError);
});

test('a wrong API key (Google answers HTTP 400, reason API_KEY_INVALID) is EmbeddingAuthError and is not retried; 401 and 403 too', async () => {
  const bad = client(V2, [googleError(400, 400, 'API_KEY_INVALID', 'API key not valid. Please pass a valid API key.')]);
  await assert.rejects(bad.embeddings.embedQuery('q'), EmbeddingAuthError);
  assert.equal(bad.calls.length, 1);
  for (const status of [401, 403]) {
    const other = client(V2, [googleError(status, status, null, 'denied')]);
    await assert.rejects(other.embeddings.embedDocuments(['d']), EmbeddingAuthError, String(status));
    assert.equal(other.calls.length, 1);
  }
});

test('any other 400 and a 404 (unknown model) are EmbeddingConfigError, not retried', async () => {
  const dims = client(V2, [googleError(400, 400, null, 'Request contains an invalid argument.')]);
  await assert.rejects(dims.embeddings.embedQuery('q'), EmbeddingConfigError);
  assert.equal(dims.calls.length, 1);
  const missing = client(V2, [googleError(404, 404, null, 'models/x is not found for API version v1beta')]);
  await assert.rejects(missing.embeddings.embedQuery('q'), (error) => error instanceof EmbeddingConfigError && /not found/.test(error.message));
  assert.equal(missing.calls.length, 1);
});

test('a call that never answers is stopped by the per-attempt timeout and retried, then EmbeddingUnavailableError', async () => {
  const hang = (call) => new Promise((_, reject) => call.signal.addEventListener('abort', () => reject(call.signal.reason)));
  const { embeddings, calls } = client(V2, [hang], { timeoutMs: 20, now: () => performance.now(), sleep: async () => {} });
  await assert.rejects(embeddings.embedQuery('q'), EmbeddingUnavailableError);
  assert.equal(calls.length, 3);
});

test('hard budget: every call ends within budgetMs: a slow 503 and long waits stop the retries early', async () => {
  // Each attempt "takes" 6 s (the fake clock jumps) and Retry-After asks for 5 s: 6 + 5 + 6 = 17, and a third wait would end at 22 > 20 s, so no third attempt starts.
  const time = clock();
  const slow503 = async () => {
    time.advance(6000);
    return json({ error: { code: 503, status: 'UNAVAILABLE', message: 'busy' } }, 503, { 'retry-after': '5' });
  };
  const { fetch, calls } = fakeFetch([slow503]);
  const embeddings = new GoogleEmbeddings({ apiKey: KEY, model: V2, profile: profile(V2), fetch, now: time.now, sleep: time.sleep, random: () => 0, warn: () => {} });
  await assert.rejects(embeddings.embedQuery('q'), EmbeddingUnavailableError);
  assert.equal(calls.length, 2, 'the wait for a third attempt would pass the 20 s budget');
  assert.ok(time.now() <= 20000, `ended at ${time.now()} ms`);
});

test('answers that cannot be used are errors, never partial results: wrong count, wrong size, NaN, zero vector, unreadable body', async () => {
  const wrongCount = client(V2, [() => json({ embeddings: [{ values: vector(768) }] })]);
  await assert.rejects(wrongCount.embeddings.embedDocuments(['a', 'b']), EmbeddingUnavailableError);
  const wrongSize = client(V2, [() => json({ embedding: { values: vector(3072) } })]);
  await assert.rejects(wrongSize.embeddings.embedQuery('q'), (error) => error instanceof EmbeddingConfigError && /768/.test(error.message));
  const nan = client(V2, [() => json({ embedding: { values: [...vector(767), null] } })]);
  await assert.rejects(nan.embeddings.embedQuery('q'), EmbeddingUnavailableError);
  const zero = client(V2, [() => json({ embedding: { values: new Array(768).fill(0) } })]);
  await assert.rejects(zero.embeddings.embedQuery('q'), EmbeddingUnavailableError);
  const html = client(V2, [() => new Response('<html>oops</html>', { status: 200 })]);
  await assert.rejects(html.embeddings.embedQuery('q'), EmbeddingUnavailableError);
});

test('mid-upload failure: when the second of three batches fails, embedDocuments rejects and returns nothing', async () => {
  const { embeddings, calls } = client(V2, [echoBatch, googleError(400, 400, null, 'bad'), echoBatch]);
  await assert.rejects(embeddings.embedDocuments(Array.from({ length: 40 }, (_, i) => `t${i}`)), EmbeddingConfigError);
  assert.equal(calls.length, 2, 'it stops at the failing batch');
});

test('the key never appears in an error message, a log line or the stats, even when Google echoes it', async (t) => {
  const logged = [];
  for (const method of ['log', 'warn', 'error']) t.mock.method(console, method, (...args) => logged.push(args.map(String).join(' ')));
  const echo = googleError(400, 400, 'API_KEY_INVALID', `API key not valid: ${KEY} is wrong (AIzaSyOTHEROTHEROTHEROTHEROTHEROTHER12)`);
  const { embeddings } = client(V2, [echo]);
  const error = await embeddings.embedQuery('q').then(() => null, (e) => e);
  assert.ok(error instanceof EmbeddingAuthError);
  for (const text of [error.message, error.stack, JSON.stringify(embeddings.stats), JSON.stringify(Object.keys(error)), ...logged]) {
    assert.doesNotMatch(text, /AIza/);
  }
  // A message that is kept in the error text (a config error) is scrubbed too, also for key-looking strings that are not ours.
  const config = client(V2, [googleError(400, 400, null, `Bad request near ${KEY} and AIzaSyOTHEROTHEROTHEROTHEROTHEROTHER12`)]);
  const configError = await config.embeddings.embedQuery('q').then(() => null, (e) => e);
  assert.ok(configError instanceof EmbeddingConfigError);
  assert.match(configError.message, /\[key\]/);
  assert.doesNotMatch(configError.message + configError.stack, /AIza/);
  const net = client(V2, [new TypeError(`fetch failed for https://x/?key=${KEY}`)]);
  const netError = await net.embeddings.embedQuery('q').then(() => null, (e) => e);
  assert.doesNotMatch(netError.message + netError.stack, /AIza/);
});

test('no key: a clear MISSING_API_KEY HttpError at the first call, and no request is made', async () => {
  const { fetch, calls } = fakeFetch([echoOne]);
  const embeddings = new GoogleEmbeddings({ apiKey: '', model: V2, profile: profile(V2), fetch });
  await assert.rejects(embeddings.embedQuery('q'), (error) => error instanceof HttpError && error.code === 'MISSING_API_KEY' && /GOOGLE_API_KEY/.test(error.message));
  assert.equal(calls.length, 0);
});

test('stats count the real HTTP calls, retries and statuses (the numbers the eval reports)', async () => {
  const { embeddings } = client(V2, [googleError(503, 503, null), echoOne]);
  await embeddings.embedQuery('q');
  assert.deepEqual({ ...embeddings.stats }, { requests: 2, retries: 1, texts: 1, byStatus: { 503: 1, 200: 1 } });
});

test('an answer that stalls after its headers is cut by the timeout and retried like a network error', async () => {
  // Headers arrive at once; the body never ends until the request is aborted.
  const stalledBody = (call) => new Response(new ReadableStream({
    start(controller) {
      call.signal.addEventListener('abort', () => controller.error(call.signal.reason));
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  const { embeddings, calls } = client(V2, [stalledBody, echoOne], { timeoutMs: 30, now: () => performance.now(), sleep: async () => {} });
  assert.equal((await embeddings.embedQuery('q')).length, 768, 'the second attempt works');
  assert.equal(calls.length, 2);
  const never = client(V2, [stalledBody], { timeoutMs: 20, now: () => performance.now(), sleep: async () => {} });
  await assert.rejects(never.embeddings.embedQuery('q'), EmbeddingUnavailableError);
  assert.equal(never.calls.length, 3);
});

test('every retry is logged (what happened and how long it waits), never with the key', async () => {
  const { embeddings, warnings } = client(V2, [googleError(503, 503, null), googleError(429, 429, null), echoOne]);
  await embeddings.embedQuery('q');
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /retry 1\/2 after 503 \(waiting 500 ms\)/);
  assert.match(warnings[1], /retry 2\/2 after 429/);
  assert.doesNotMatch(warnings.join(), /AIza/);
});

test('the visitor leaves: an aborted signal stops at once (no retry of the aborted call, no further batch)', async () => {
  const controller = new AbortController();
  const hang = (call) => new Promise((_, reject) => call.signal.addEventListener('abort', () => reject(call.signal.reason)));
  const during = client(V2, [hang]);
  const pending = during.embeddings.embedDocuments(['a', 'b'], { signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, (error) => error.code === 'CLIENT_GONE');
  assert.equal(during.calls.length, 1, 'the aborted call is not retried');
  // Between batches: the first batch worked, the visitor left, so the second is never sent.
  const between = new AbortController();
  const { embeddings, calls } = client(V2, [(call) => { between.abort(); return echoBatch(call); }]);
  await assert.rejects(embeddings.embedDocuments(Array.from({ length: 40 }, (_, i) => `t${i}`), { signal: between.signal }), (error) => error.code === 'CLIENT_GONE');
  assert.equal(calls.length, 1);
  // An already aborted signal makes no call at all.
  const none = client(V2, [echoBatch]);
  await assert.rejects(none.embeddings.embedDocuments(['a'], { signal: AbortSignal.abort() }), (error) => error.code === 'CLIENT_GONE');
  assert.equal(none.calls.length, 0);
});
