import './env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEmbeddingProfile, truncateAndNormalize } from '../src/services/embeddingProfile.js';

const DEFAULT = 'Xenova/all-MiniLM-L6-v2';

test('the default model keeps today\'s behaviour: mean pooling, normalised, no prefixes, full size', () => {
  const profile = resolveEmbeddingProfile(DEFAULT, {});
  assert.deepEqual({ ...profile }, { pooling: 'mean', normalize: true, queryPrefix: '', documentPrefix: '', dimensions: null, known: true, nativeDimensions: 384, sourceMinScore: 0.2, sourceRelativeScore: 0.7, warnings: [] });
});

test('every verified model has the pooling and prefixes of its model card', () => {
  const e5 = { pooling: 'mean', queryPrefix: 'query: ', documentPrefix: 'passage: ' };
  for (const model of ['Xenova/multilingual-e5-small', 'Xenova/multilingual-e5-base']) {
    const profile = resolveEmbeddingProfile(model, {});
    assert.equal(profile.known, true, model);
    assert.deepEqual({ pooling: profile.pooling, queryPrefix: profile.queryPrefix, documentPrefix: profile.documentPrefix }, e5, model);
  }
  const gemma = resolveEmbeddingProfile('onnx-community/embeddinggemma-300m-ONNX', {});
  assert.deepEqual({ pooling: gemma.pooling, queryPrefix: gemma.queryPrefix, documentPrefix: gemma.documentPrefix, nativeDimensions: gemma.nativeDimensions }, { pooling: 'model', queryPrefix: 'task: search result | query: ', documentPrefix: 'title: none | text: ', nativeDimensions: 768 });
  const qwen = resolveEmbeddingProfile('onnx-community/Qwen3-Embedding-0.6B-ONNX', {});
  assert.equal(qwen.pooling, 'last_token');
  assert.equal(qwen.queryPrefix, 'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:');
  assert.equal(qwen.documentPrefix, '');
  assert.equal(qwen.nativeDimensions, 1024);
});

test('model ids match without regard to case', () => {
  assert.equal(resolveEmbeddingProfile('xenova/MULTILINGUAL-E5-SMALL', {}).queryPrefix, 'query: ');
});

test('environment settings override the table; set-but-empty clears a prefix; "\\n" becomes a newline', () => {
  const e5 = 'Xenova/multilingual-e5-small';
  assert.equal(resolveEmbeddingProfile(e5, { EMBEDDING_QUERY_PREFIX: '' }).queryPrefix, '');
  assert.equal(resolveEmbeddingProfile(e5, { EMBEDDING_DOCUMENT_PREFIX: 'doc: ' }).documentPrefix, 'doc: ');
  assert.equal(resolveEmbeddingProfile(e5, { EMBEDDING_QUERY_PREFIX: 'Instruct: x\\nQuery:' }).queryPrefix, 'Instruct: x\nQuery:');
  // Unset keeps the table value, and prefixes are never trimmed (the trailing space matters).
  assert.equal(resolveEmbeddingProfile(e5, {}).queryPrefix, 'query: ');
  assert.equal(resolveEmbeddingProfile(DEFAULT, { EMBEDDING_QUERY_PREFIX: 'q: ' }).queryPrefix, 'q: ');
});

test('EMBEDDING_POOLING accepts mean, cls and last_token; anything else is ignored with a warning, never an error', () => {
  for (const pooling of ['mean', 'cls', 'last_token']) assert.equal(resolveEmbeddingProfile(DEFAULT, { EMBEDDING_POOLING: pooling }).pooling, pooling);
  assert.equal(resolveEmbeddingProfile(DEFAULT, { EMBEDDING_POOLING: ' CLS ' }).pooling, 'cls');
  for (const bad of ['model', 'max', 'banana']) {
    const profile = resolveEmbeddingProfile(DEFAULT, { EMBEDDING_POOLING: bad });
    assert.equal(profile.pooling, 'mean', bad);
    assert.equal(profile.warnings.length, 1, bad);
    assert.match(profile.warnings[0], /EMBEDDING_POOLING/);
  }
  // The table's own "model" pooling cannot be overridden by an invalid value either.
  assert.equal(resolveEmbeddingProfile('onnx-community/embeddinggemma-300m-ONNX', { EMBEDDING_POOLING: 'banana' }).pooling, 'model');
});

test('EMBEDDING_DIMENSIONS: a positive whole number up to the known size; otherwise ignored with a warning', () => {
  const gemma = 'onnx-community/embeddinggemma-300m-ONNX';
  assert.equal(resolveEmbeddingProfile(gemma, { EMBEDDING_DIMENSIONS: '256' }).dimensions, 256);
  assert.equal(resolveEmbeddingProfile(gemma, {}).dimensions, null);
  for (const bad of ['0', '-5', '1.5', 'abc', '769']) {
    const profile = resolveEmbeddingProfile(gemma, { EMBEDDING_DIMENSIONS: bad });
    assert.equal(profile.dimensions, null, bad);
    assert.equal(profile.warnings.length, 1, bad);
  }
  // An unknown model has no known size, so any positive whole number is accepted.
  assert.equal(resolveEmbeddingProfile('someone/unknown-embedder', { EMBEDDING_DIMENSIONS: '4096' }).dimensions, 4096);
});

test('an unknown model gets mean pooling, no prefixes and one warning that names it; an override silences nothing it did not set', () => {
  const profile = resolveEmbeddingProfile('someone/unknown-embedder', {});
  assert.equal(profile.known, false);
  assert.deepEqual([profile.pooling, profile.queryPrefix, profile.documentPrefix, profile.dimensions], ['mean', '', '', null]);
  assert.equal(profile.warnings.length, 1);
  assert.match(profile.warnings[0], /someone\/unknown-embedder/);
  // With overrides the user has said what the model card says: still flagged as not verified, but one warning only.
  const custom = resolveEmbeddingProfile('someone/unknown-embedder', { EMBEDDING_POOLING: 'cls', EMBEDDING_QUERY_PREFIX: 'query: ' });
  assert.equal(custom.pooling, 'cls');
  assert.equal(custom.warnings.length, 1);
});

test('truncateAndNormalize keeps the first N values and gives the vector length 1', () => {
  const vector = [3, 4, 12, 0];
  assert.deepEqual(truncateAndNormalize(vector, 2), [0.6, 0.8]);
  const full = truncateAndNormalize(vector, null);
  assert.equal(full, vector, 'null means untouched: the very same array');
  const cut = truncateAndNormalize([1, 1, 1, 1], 3);
  assert.ok(Math.abs(Math.hypot(...cut) - 1) < 1e-12);
  assert.throws(() => truncateAndNormalize([1, 2], 3), /3 .*only 2/);
  assert.deepEqual(truncateAndNormalize([0, 0, 5], 2), [0, 0], 'a zero vector stays zero, never NaN');
});

test('an empty EMBEDDING_POOLING or EMBEDDING_DIMENSIONS (a bare line in .env) means "not set": no warning, table values kept', () => {
  const gemma = resolveEmbeddingProfile('onnx-community/embeddinggemma-300m-ONNX', { EMBEDDING_POOLING: '', EMBEDDING_DIMENSIONS: '  ' });
  assert.deepEqual([gemma.pooling, gemma.dimensions, gemma.warnings], ['model', null, []]);
});

test('the sources shown when the model cites none are part of the profile: MiniLM keeps 0.2 / 0.7, other models have their own', () => {
  const thresholds = (model, env = {}) => { const p = resolveEmbeddingProfile(model, env); return [p.sourceMinScore, p.sourceRelativeScore]; };
  assert.deepEqual(thresholds(DEFAULT), [0.2, 0.7], 'the default model must not change');
  // e5 scores sit in a narrow band (0.7-0.9), so a 0.7 relative rule keeps everything: it needs a much tighter rule.
  assert.deepEqual(thresholds('Xenova/multilingual-e5-small'), [0.2, 0.92]);
  assert.deepEqual(thresholds('Xenova/multilingual-e5-base'), [0.2, 0.92]);
  assert.deepEqual(thresholds('onnx-community/embeddinggemma-300m-ONNX'), [0.2, 0.55]);
  assert.deepEqual(thresholds('onnx-community/Qwen3-Embedding-0.6B-ONNX'), [0.2, 0.8]);
  assert.deepEqual(thresholds('someone/unknown-embedder'), [0.2, 0.7], 'an unlisted model gets the MiniLM rule (with the startup warning)');
});

test('EMBEDDING_SOURCE_MIN_SCORE and EMBEDDING_SOURCE_RELATIVE_SCORE override the table; bad values are ignored with a warning', () => {
  const ok = resolveEmbeddingProfile('someone/unknown-embedder', { EMBEDDING_SOURCE_MIN_SCORE: '0.5', EMBEDDING_SOURCE_RELATIVE_SCORE: '0.9' });
  assert.deepEqual([ok.sourceMinScore, ok.sourceRelativeScore], [0.5, 0.9]);
  for (const bad of ['abc', '-1', '1.5', 'NaN', 'Infinity']) {
    const profile = resolveEmbeddingProfile(DEFAULT, { EMBEDDING_SOURCE_MIN_SCORE: bad, EMBEDDING_SOURCE_RELATIVE_SCORE: bad });
    assert.deepEqual([profile.sourceMinScore, profile.sourceRelativeScore], [0.2, 0.7], bad);
    assert.equal(profile.warnings.length, 2, bad);
  }
  assert.equal(resolveEmbeddingProfile(DEFAULT, { EMBEDDING_SOURCE_RELATIVE_SCORE: '0' }).sourceRelativeScore, 0.7, 'a relative rule of 0 would show everything: ignored');
  assert.equal(resolveEmbeddingProfile(DEFAULT, { EMBEDDING_SOURCE_MIN_SCORE: '' }).warnings.length, 0, 'set-but-empty means unset');
});
