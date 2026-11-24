import './env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitCitations, pickSourceChunks } from '../src/services/ragChain.js';
import { resolveEmbeddingProfile } from '../src/services/embeddingProfile.js';

test('reads the SOURCES line and removes it from the answer', () => {
  assert.deepEqual(splitCitations('The warranty is 18 months.\nSOURCES: 1, 3'), { answer: 'The warranty is 18 months.', cited: [1, 3] });
});

test('accepts bold, missing colon and extra spaces', () => {
  assert.deepEqual(splitCitations('Answer.\n**SOURCES:** 2').cited, [2]);
  assert.deepEqual(splitCitations('Answer.\nSources 4 ,5  ').cited, [4, 5]);
});

test('"SOURCES: none" means no citations', () => {
  assert.deepEqual(splitCitations("I couldn't find that.\nSOURCES: none"), { answer: "I couldn't find that.", cited: [] });
});

test('no SOURCES line returns cited null, and the answer stays whole', () => {
  assert.deepEqual(splitCitations('Just an answer.'), { answer: 'Just an answer.', cited: null });
});

test('only the last line counts, not the word "sources" in the text', () => {
  const { answer, cited } = splitCitations('Our sources: 2 suppliers deliver daily.\nSOURCES: 1');
  assert.equal(answer, 'Our sources: 2 suppliers deliver daily.');
  assert.deepEqual(cited, [1]);
});

test('a SOURCES list may end the last sentence, but ordinary text about sources stays', () => {
  assert.deepEqual(splitCitations('18 months. SOURCES: 1, 2'), { answer: '18 months.', cited: [1, 2] });
  assert.deepEqual(splitCitations('The sources are described in the appendix.'), { answer: 'The sources are described in the appendix.', cited: null });
  assert.deepEqual(splitCitations('Sources of income: salary.').cited, null);
});

test('citation lists with brackets, "and" or ranges are read too', () => {
  assert.deepEqual(splitCitations('The warranty is 18 months.\nSOURCES: [1], [3]'), { answer: 'The warranty is 18 months.', cited: [1, 3] });
  assert.deepEqual(splitCitations('18 months.\nSOURCES: 1 and 3').cited, [1, 3]);
  assert.deepEqual(splitCitations('18 months. SOURCES: 1-3').cited, [1, 3]);
  assert.equal(splitCitations('Our sources: 2 and more suppliers.').cited, null);
});

// ---- the sources shown when the model cites nothing: the thresholds come from the embedding profile ----
const hit = (name, score) => [{ metadata: { source: name } }, score];
const e5Scores = [hit('a', 0.9), hit('b', 0.85), hit('c', 0.82), hit('d', 0.78)];
const minilmScores = [hit('a', 0.6), hit('b', 0.5), hit('c', 0.3), hit('d', 0.05)];
const names = (chunks) => chunks.map((chunk) => chunk.metadata.source);

test('the default profile keeps today\'s rule: at least 0.2 and at least 70% of the best score', () => {
  const minilm = resolveEmbeddingProfile('Xenova/all-MiniLM-L6-v2', {});
  assert.deepEqual(names(pickSourceChunks(minilmScores, null, minilm)), ['a', 'b'], '0.6 x 0.7 = 0.42: a and b pass, 0.3 and 0.05 do not');
  assert.deepEqual(names(pickSourceChunks(minilmScores, null)), ['a', 'b'], 'with no profile argument the configured (default) one is used');
});

test('a squeezed score band needs its own rule: the MiniLM rule shows all four e5 chunks, the e5 profile does not', () => {
  const minilm = resolveEmbeddingProfile('Xenova/all-MiniLM-L6-v2', {});
  const e5 = resolveEmbeddingProfile('Xenova/multilingual-e5-small', {});
  assert.deepEqual(names(pickSourceChunks(e5Scores, null, minilm)), ['a', 'b', 'c', 'd']);
  assert.deepEqual(names(pickSourceChunks(e5Scores, null, e5)), ['a', 'b'], '0.9 x 0.92 = 0.828');
});

test('cited chunks are shown whatever their score (the thresholds only apply when nothing was cited)', () => {
  const e5 = resolveEmbeddingProfile('Xenova/multilingual-e5-small', {});
  assert.deepEqual(names(pickSourceChunks(e5Scores, [4, 1], e5)), ['d', 'a']);
});
