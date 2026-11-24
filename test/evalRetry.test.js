// Tests for the retry guard (eval/retry.js). Pure: no .env, key, model or network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retryProblems } from '../eval/retry.js';

const settings = { mainModel: 'm', fallbackModel: null, thinking: { main: { thinkingLevel: 'minimal' }, fallback: null }, fakeLlm: false, embeddingModel: 'e', embeddingDtype: 'q8', embeddingProfile: { pooling: 'mean', queryPrefix: '', documentPrefix: '', dimensions: null }, chunkSize: 1000, chunkOverlap: 150, topK: 4, mode: 'full' };
const prev = (ids, extra = {}) => ({ meta: { ...settings, datasetFingerprint: 'abc', ...extra }, results: ids.map((id) => ({ id })) });
const now = (extra = {}) => ({ settings: { ...settings, ...extra }, fingerprint: 'abc', questionIds: ['a', 'b', 'c'] });

test('a previous run with an errored question may be retried', () => {
  const errored = { meta: { ...settings, datasetFingerprint: 'abc' }, results: [{ id: 'a' }, { id: 'b', error: { code: 'LLM_BUSY' } }, { id: 'c' }] };
  assert.deepEqual(retryProblems(errored, now()), []);
});

test('a complete run with no error is refused: nothing to retry, and a finished baseline is never rewritten', () => {
  assert.match(retryProblems(prev(['a', 'b', 'c']), now()).join(), /nothing to retry/);
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

test('a different thinking setting for the main model or for the fallback model is rejected', () => {
  assert.match(retryProblems(prev(['a']), now({ thinking: { main: { thinkingLevel: 'high' }, fallback: null } })).join(), /thinking differs/);
  assert.match(retryProblems(prev(['a']), now({ thinking: { main: { thinkingLevel: 'minimal' }, fallback: { thinkingLevel: 'low' } } })).join(), /thinking differs/);
});

test('a run with the fake model cannot be completed by a real run, or the other way round', () => {
  assert.match(retryProblems(prev(['a'], { fakeLlm: true }), now()).join(), /fakeLlm differs/);
  assert.match(retryProblems(prev(['a']), now({ fakeLlm: true })).join(), /fakeLlm differs/);
});

test('a different embedding profile (pooling, prefixes or dimensions) is rejected: the vectors would not be comparable', () => {
  assert.match(retryProblems(prev(['a']), now({ embeddingProfile: { pooling: 'mean', queryPrefix: 'query: ', documentPrefix: '', dimensions: null } })).join(), /embeddingProfile differs/);
  assert.match(retryProblems(prev(['a']), now({ embeddingProfile: { pooling: 'mean', queryPrefix: '', documentPrefix: '', dimensions: 128 } })).join(), /embeddingProfile differs/);
  // A results file from before this setting existed cannot be completed either.
  assert.match(retryProblems({ meta: { ...settings, embeddingProfile: undefined, datasetFingerprint: 'abc' }, results: [] }, now()).join(), /embeddingProfile differs/);
});
