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
