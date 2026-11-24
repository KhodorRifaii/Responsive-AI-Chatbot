// Tests for the retry guard (eval/retry.js). Pure: no .env, key, model or network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retryProblems } from '../eval/retry.js';

const settings = { mainModel: 'm', fallbackModel: null, thinkingBudget: null, embeddingModel: 'e', embeddingDtype: 'q8', chunkSize: 1000, chunkOverlap: 150, topK: 4, mode: 'full' };
const prev = (ids, extra = {}) => ({ meta: { ...settings, datasetFingerprint: 'abc', ...extra }, results: ids.map((id) => ({ id })) });
const now = (extra = {}) => ({ settings: { ...settings, ...extra }, fingerprint: 'abc', questionIds: ['a', 'b', 'c'] });

test('a complete previous run of the same settings and data may be retried', () => {
  assert.deepEqual(retryProblems(prev(['a', 'b', 'c']), now()), []);
});

test('a run that stopped half way can be resumed: missing ids are simply asked', () => {
  assert.deepEqual(retryProblems(prev(['a', 'b']), now()), []);
  assert.deepEqual(retryProblems(prev([]), now()), []);
});

test('ids that are not in the dataset, or listed twice, are rejected', () => {
  assert.match(retryProblems(prev(['a', 'zzz']), now()).join(), /not in the question file: zzz/);
  assert.match(retryProblems(prev(['a', 'a']), now()).join(), /twice: a/);
});

test('different settings, models or data are rejected', () => {
  assert.match(retryProblems(prev(['a']), now({ mainModel: 'other' })).join(), /mainModel/);
  assert.match(retryProblems(prev(['a']), now({ fallbackModel: 'f' })).join(), /fallbackModel/);
  assert.match(retryProblems(prev(['a']), { ...now(), fingerprint: 'changed' }).join(), /questions or documents/);
  assert.match(retryProblems({ results: [] }, now()).join(), /mainModel/);
});
