// Tests for the embedder comparison summary (eval/embedderSummary.js). Pure: no model, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeRun, FLAG_RSS_MB } from '../eval/embedderSummary.js';

const group = (answerable, hitAll, hitAny, top1, chance = 0.4, chanceTop1 = 0.15, a = 0.5, u = 0.4) => ({
  answerable, retrievalAll: hitAll / answerable, retrievalAny: hitAny / answerable, retrievalTop1: top1 / answerable, chance, chanceTop1, topScoreAnswerable: a, topScoreUnanswerable: u,
});
const raw = (performance) => ({
  meta: {
    embeddingModel: 'm', embeddingDtype: 'q8', embeddingProfile: { pooling: 'mean', queryPrefix: '', documentPrefix: '', dimensions: null }, performance,
    summary: { all: group(4, 3, 4, 2), en: group(2, 2, 2, 2), ar: group(2, 1, 2, 0), unanswerable: { answerable: 0 } },
  },
  results: [
    { id: 'a', lang: 'en', retrieved: [{ source: 'x.txt', chunk: 1 }] },
    { id: 'b', lang: 'en', retrieved: [{ source: 'y.txt', chunk: 0 }] },
    { id: 'c', lang: 'ar', retrieved: [{ source: 'z.txt', chunk: 2 }] },
    { id: 'd', lang: 'ar', retrieved: [{ source: 'z.txt', chunk: 2 }] },
    { id: 'e', lang: 'ar', retrieved: [{ source: 'w.txt', chunk: 0 }] },
  ],
});

test('counts, Wilson intervals, random baselines and scores per slice', () => {
  const out = summarizeRun(raw({ peakRssMb: 300, modelLoadMs: 5 }));
  assert.equal(out.retrieval.all.n, 4);
  assert.equal(out.retrieval.all.hitAll.k, 3);
  assert.equal(out.retrieval.all.top1.k, 2);
  assert.deepEqual(out.retrieval.ar.top1, { k: 0, n: 2, share: 0, low: 0, high: out.retrieval.ar.top1.high });
  assert.ok(out.retrieval.ar.top1.high > 0.6 && out.retrieval.ar.top1.high < 0.7, 'Wilson upper bound for 0 of 2 is about 0.66');
  assert.equal(out.retrieval.all.random.topK, 0.4);
  assert.equal(out.topScore.answerable, 0.5);
  assert.equal(out.retrieval.unanswerable, undefined, 'only slices with answerable questions are reported');
});

test('top-1 spread: how many different chunks come first, and how often the most frequent one does', () => {
  const out = summarizeRun(raw({ peakRssMb: 300 }));
  assert.deepEqual(out.top1Spread.ar, { questions: 3, distinctChunks: 2, mostFrequent: 'z.txt#2', times: 2 });
  assert.deepEqual(out.top1Spread.en, { questions: 2, distinctChunks: 2, mostFrequent: 'x.txt#1', times: 1 });
});

test('a model whose peak memory reaches the flag line is flagged', () => {
  assert.equal(FLAG_RSS_MB, 450);
  assert.equal(summarizeRun(raw({ peakRssMb: 449 })).nearLimit, false);
  assert.equal(summarizeRun(raw({ peakRssMb: 450 })).nearLimit, true);
  assert.equal(summarizeRun(raw({ peakRssMb: 900 })).nearLimit, true);
});
