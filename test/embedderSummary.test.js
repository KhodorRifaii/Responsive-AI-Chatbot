// Tests for the embedder comparison summary (eval/embedderSummary.js). Pure: no model, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeRun, FLAG_RSS_MB } from '../eval/embedderSummary.js';

const group = (answerable, hitAll, hitAny, top1, chance = 0.4, chanceTop1 = 0.15, a = 0.5, u = 0.4, chunk = undefined) => ({
  answerable, retrievalAll: hitAll / answerable, retrievalAny: hitAny / answerable, retrievalTop1: top1 / answerable, chance, chanceTop1, topScoreAnswerable: a, topScoreUnanswerable: u,
  ...(chunk === undefined ? {} : { retrievalChunk: chunk / answerable }),
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

test('fallback source filter: how many of the 4 chunks pass the app\'s score rule (a compressed score range lets all of them pass)', () => {
  const run = raw({ peakRssMb: 300 });
  // Scores 0.9, 0.85, 0.8, 0.75 with a 0.7 relative rule: threshold 0.63, all four pass. Scores 0.9, 0.5, 0.3, 0.1: only the first passes.
  run.results = [
    { id: 'a', lang: 'en', retrieved: [0.9, 0.85, 0.8, 0.75].map((score) => ({ source: 'x.txt', chunk: 0, score })) },
    { id: 'b', lang: 'ar', retrieved: [0.9, 0.5, 0.3, 0.1].map((score) => ({ source: 'y.txt', chunk: 0, score })) },
  ];
  const out = summarizeRun(run, { minScore: 0.2, relativeScore: 0.7 });
  assert.deepEqual(out.sourceFilter, { questions: 2, averageChunksShown: 2.5, allFourShown: 1 });
});

test('a question that retrieved nothing is reported, not a crash', () => {
  const run = raw({ peakRssMb: 300 });
  run.results = [{ id: 'a', lang: 'en', retrieved: [] }, { id: 'b', lang: 'ar', retrieved: [{ source: 'z.txt', chunk: 0, score: 0.5 }] }];
  const out = summarizeRun(run);
  assert.equal(out.top1Spread.en.mostFrequent, '(nothing retrieved)');
  assert.deepEqual(out.sourceFilter, { questions: 2, averageChunksShown: 0.5, allFourShown: 0 });
});

test('chunk-level hit with its Wilson interval, only when the run computed it', () => {
  const old = summarizeRun(raw({ peakRssMb: 300 }));
  assert.equal(old.retrieval.all.hitChunk, undefined, 'a run scored before the metric existed has no chunk column');
  const run = raw({ peakRssMb: 300 });
  run.meta.summary.all = group(4, 3, 4, 2, 0.4, 0.15, 0.5, 0.4, 2);
  const out = summarizeRun(run);
  assert.equal(out.retrieval.all.hitChunk.k, 2);
  assert.equal(out.retrieval.all.hitChunk.n, 4);
  assert.ok(out.retrieval.all.hitChunk.low > 0.15 && out.retrieval.all.hitChunk.high < 0.85);
});
