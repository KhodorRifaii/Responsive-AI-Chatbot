import './env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalEmbeddings } from '../src/services/embeddings.js';
import { resolveEmbeddingProfile } from '../src/services/embeddingProfile.js';
import { EmbeddingConfigError } from '../src/services/embeddingErrors.js';

/** An extractor that records its calls and answers with a fixed vector per call, like the real pipeline's tensor. */
function fakeExtractor(vector = [3, 4, 0, 0]) {
  const calls = [];
  const extractor = async (texts, options) => {
    calls.push({ texts, options });
    return { tolist: () => texts.map(() => [...vector]) };
  };
  return { calls, extractor };
}

function embedderWith(model, extractor, extra = {}) {
  return new LocalEmbeddings({ model, loadExtractor: async () => extractor, ...extra });
}

test('default model: the extractor gets the raw text and exactly { pooling: mean, normalize: true }, vectors come back untouched', async () => {
  const { calls, extractor } = fakeExtractor();
  const embeddings = embedderWith('Xenova/all-MiniLM-L6-v2', extractor);
  const docs = await embeddings.embedDocuments(['one', 'two']);
  const query = await embeddings.embedQuery('question?');
  assert.deepEqual(calls.map((c) => c.texts), [['one'], ['two'], ['question?']], 'batch size 1, no prefix');
  for (const call of calls) assert.deepEqual(call.options, { pooling: 'mean', normalize: true });
  assert.deepEqual(docs, [[3, 4, 0, 0], [3, 4, 0, 0]]);
  assert.deepEqual(query, [3, 4, 0, 0]);
});

test('e5: documents get "passage: " and queries get "query: "', async () => {
  const { calls, extractor } = fakeExtractor();
  const embeddings = embedderWith('Xenova/multilingual-e5-small', extractor);
  await embeddings.embedDocuments(['مرحبا']);
  await embeddings.embedQuery('كم يوم؟');
  assert.deepEqual(calls.map((c) => c.texts[0]), ['passage: مرحبا', 'query: كم يوم؟']);
});

test('the profile can come from the environment settings: pooling is passed on to the extractor', async () => {
  const { calls, extractor } = fakeExtractor();
  const profile = resolveEmbeddingProfile('Xenova/multilingual-e5-small', { EMBEDDING_POOLING: 'cls', EMBEDDING_QUERY_PREFIX: 'q> ' });
  const embeddings = embedderWith('Xenova/multilingual-e5-small', extractor, { profile });
  await embeddings.embedQuery('hi');
  assert.deepEqual(calls[0], { texts: ['q> hi'], options: { pooling: 'cls', normalize: true } });
});

test('dimensions: vectors are cut to the first N values and re-normalised, for queries and documents', async () => {
  const { extractor } = fakeExtractor([3, 4, 12, 0]);
  const profile = resolveEmbeddingProfile('onnx-community/embeddinggemma-300m-ONNX', { EMBEDDING_DIMENSIONS: '2' });
  const embeddings = embedderWith('onnx-community/embeddinggemma-300m-ONNX', extractor, { profile });
  assert.deepEqual(await embeddings.embedQuery('q'), [0.6, 0.8]);
  assert.deepEqual(await embeddings.embedDocuments(['d']), [[0.6, 0.8]]);
});

test('a vector shorter than EMBEDDING_DIMENSIONS is a clear error that names the model', async () => {
  const { extractor } = fakeExtractor([1, 2]);
  const profile = resolveEmbeddingProfile('someone/unknown-embedder', { EMBEDDING_DIMENSIONS: '8' });
  const embeddings = embedderWith('someone/unknown-embedder', extractor, { profile });
  await assert.rejects(embeddings.embedQuery('q'), (error) => {
    assert.ok(error instanceof EmbeddingConfigError, 'a setting that does not fit the model is a config error');
    assert.match(error.message, /someone\/unknown-embedder.*only 2/s);
    return true;
  });
});

test('a failed load is not cached: the next call tries again', async () => {
  let attempts = 0;
  const { extractor } = fakeExtractor();
  const embeddings = new LocalEmbeddings({
    model: 'Xenova/all-MiniLM-L6-v2',
    loadExtractor: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('offline');
      return extractor;
    },
  });
  await assert.rejects(embeddings.embedQuery('q'), /offline/);
  assert.deepEqual(await embeddings.embedQuery('q'), [3, 4, 0, 0]);
  assert.equal(attempts, 2);
});

test('a model id that does not exist on the Hub is a config error naming the model', async () => {
  const embeddings = new LocalEmbeddings({
    model: 'Xenova/no-such-model',
    loadExtractor: async () => {
      throw Object.assign(new Error('Unauthorized access to file: "https://huggingface.co/Xenova/no-such-model/resolve/main/config.json".'), { name: 'ModelFileNotFoundError' });
    },
  });
  await assert.rejects(embeddings.embedQuery('q'), (error) => {
    assert.ok(error instanceof EmbeddingConfigError);
    assert.match(error.message, /Xenova\/no-such-model.*not found/s);
    return true;
  });
});

test('a model without a sentence_embedding output cannot use pooling "model": config error', async () => {
  const { requireSentenceEmbedding } = await import('../src/services/embeddings.js');
  assert.throws(() => requireSentenceEmbedding({}, 'onnx-community/x'), EmbeddingConfigError);
  assert.equal(requireSentenceEmbedding({ sentence_embedding: 'ok' }, 'm'), 'ok');
});
