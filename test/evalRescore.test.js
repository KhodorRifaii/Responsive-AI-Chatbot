// Tests for adding the chunk-level score to stored results (eval/rescore.js). Pure: no model, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addChunkLevel } from '../eval/rescore.js';

const questions = [
  { id: 'a', lang: 'en', type: 'single', sources: ['hr.txt'], facts: [['24 working days']] },
  { id: 'b', lang: 'ar', type: 'single', sources: ['hr.txt'], facts: [['90 days']] },
  { id: 'n', lang: 'en', type: 'unanswerable', sources: [], facts: [] },
];
const texts = { 'hr.txt#1': 'Leave: 24 working days.', 'hr.txt#2': 'Probation: 90 days.' };
const chunkText = (source, chunk) => texts[`${source}#${chunk}`];
const result = (id, retrieved) => ({ id, lang: id === 'b' ? 'ar' : 'en', retrieved, score: { id, answerable: id !== 'n', retrievalAll: id !== 'n', retrievalAny: id !== 'n', retrievalTop1: id !== 'n', noAnswer: true, topScore: 0.5 } });
const raw = { meta: { mode: 'retrieval-only', embeddingModel: 'm' }, results: [result('a', [{ source: 'hr.txt', chunk: 1 }]), result('b', [{ source: 'hr.txt', chunk: 1 }]), result('n', [])] };

test('addChunkLevel: file-level hit for both answerable questions, chunk-level only for the one whose chunk holds the fact', () => {
  const out = addChunkLevel(raw, questions, chunkText);
  assert.equal(out.results[0].score.retrievalChunk, true);
  assert.equal(out.results[1].score.retrievalChunk, false);
  assert.equal('retrievalChunk' in out.results[2].score, false);
  assert.equal(out.meta.summary.all.retrievalAll, 1);
  assert.equal(out.meta.summary.all.retrievalChunk, 0.5);
  assert.equal(out.meta.summary.en.retrievalChunk, 1);
  assert.equal(out.meta.summary.ar.retrievalChunk, 0);
  assert.equal(out.meta.embeddingModel, 'm', 'the rest of the metadata is kept');
});

test('addChunkLevel: does not change its input, and an unknown question id is an error', () => {
  addChunkLevel(raw, questions, chunkText);
  assert.equal('retrievalChunk' in raw.results[0].score, false);
  assert.throws(() => addChunkLevel({ ...raw, results: [result('zzz', [])] }, questions, chunkText), /zzz/);
});
