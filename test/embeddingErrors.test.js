import './env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EmbeddingConfigError, toEmbeddingHttpError } from '../src/services/embeddingErrors.js';
import { HttpError } from '../src/utils/httpError.js';

test('a config error becomes 503 EMBEDDING_CONFIG with the settings to check', () => {
  const error = toEmbeddingHttpError(new EmbeddingConfigError('EMBEDDING_DIMENSIONS asks for 9999 values but the model returned only 384.'), { model: 'm' });
  assert.ok(error instanceof HttpError);
  assert.equal(error.status, 503);
  assert.equal(error.code, 'EMBEDDING_CONFIG');
  assert.match(error.message, /Check EMBEDDING_MODEL, EMBEDDING_POOLING and EMBEDDING_DIMENSIONS in \.env\.$/);
  assert.match(error.message, /9999/);
});

test('anything else is 503 EMBEDDING_FAILED naming EMBEDDING_MODEL and the model', () => {
  const error = toEmbeddingHttpError(new Error('fetch failed'), { model: 'Xenova/all-MiniLM-L6-v2' });
  assert.equal(error.status, 503);
  assert.equal(error.code, 'EMBEDDING_FAILED');
  assert.match(error.message, /Xenova\/all-MiniLM-L6-v2/);
  assert.match(error.message, /EMBEDDING_MODEL/);
  assert.match(error.message, /internet/i);
});

test('an HttpError already written for the user passes through unchanged', () => {
  const original = new HttpError(503, 'MISSING_API_KEY', 'add GOOGLE_API_KEY');
  assert.equal(toEmbeddingHttpError(original, { model: 'm' }), original);
});

// ---- hosted provider ----
import { EmbeddingAuthError, EmbeddingQuotaError, EmbeddingUnavailableError } from '../src/services/embeddingErrors.js';

test('Google: key, quota, busy service and settings each have their own code, status and message', () => {
  const google = { model: 'gemini-embedding-2', provider: 'google' };
  const auth = toEmbeddingHttpError(new EmbeddingAuthError('Google rejected the API key (400).'), google);
  assert.deepEqual([auth.status, auth.code], [502, 'EMBEDDING_AUTH']);
  assert.match(auth.message, /GOOGLE_API_KEY/);
  const quota = toEmbeddingHttpError(new EmbeddingQuotaError('x'), google);
  assert.deepEqual([quota.status, quota.code], [429, 'EMBEDDING_RATE_LIMIT']);
  assert.match(quota.message, /shared with the chat/);
  const busy = toEmbeddingHttpError(new EmbeddingUnavailableError('x'), google);
  assert.deepEqual([busy.status, busy.code], [503, 'EMBEDDING_FAILED']);
  assert.doesNotMatch(busy.message, /internet connection \(needed once to download/, 'nothing is downloaded with the hosted provider');
  const config = toEmbeddingHttpError(new EmbeddingConfigError('Google rejected the request for "gemini-embedding-2" (404: not found).'), google);
  assert.equal(config.code, 'EMBEDDING_CONFIG');
  assert.match(config.message, /Check EMBEDDING_PROVIDER, EMBEDDING_MODEL and EMBEDDING_DIMENSIONS in \.env\.$/);
});

test('the user-facing messages never carry raw provider text (it could echo a key)', () => {
  const secret = 'AIzaSyLEAKLEAKLEAKLEAKLEAKLEAKLEAKLEAK12';
  for (const error of [new EmbeddingAuthError(secret), new EmbeddingQuotaError(secret), new EmbeddingUnavailableError(secret), new Error(secret)]) {
    assert.doesNotMatch(toEmbeddingHttpError(error, { model: 'm', provider: 'google' }).message, /AIza/);
    assert.doesNotMatch(toEmbeddingHttpError(error, { model: 'm', provider: 'local' }).message, /AIza/);
  }
});
