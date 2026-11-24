// Tests for the embedder comparison summary (eval/embedderSummary.js). Pure: no model, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeRun, sourceRuleOf, sourceRuleF1, MINILM_RULE, FLAG_RSS_MB } from '../eval/embedderSummary.js';

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
  assert.deepEqual(out.sourceFilter, { rule: { minScore: 0.2, relativeScore: 0.7 }, questions: 2, averageChunksShown: 2.5, allFourShown: 1, f1: null, f1WithMiniLmRule: null });
});

test('a question that retrieved nothing is reported, not a crash', () => {
  const run = raw({ peakRssMb: 300 });
  run.results = [{ id: 'a', lang: 'en', retrieved: [] }, { id: 'b', lang: 'ar', retrieved: [{ source: 'z.txt', chunk: 0, score: 0.5 }] }];
  const out = summarizeRun(run);
  assert.equal(out.top1Spread.en.mostFrequent, '(nothing retrieved)');
  assert.deepEqual(out.sourceFilter, { rule: { minScore: 0.2, relativeScore: 0.7 }, questions: 2, averageChunksShown: 0.5, allFourShown: 0, f1: null, f1WithMiniLmRule: null });
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

test('each run is summarised with its own model\'s source rule: saved thresholds first, else the model\'s profile', () => {
  assert.deepEqual(sourceRuleOf({ embeddingModel: 'Xenova/all-MiniLM-L6-v2' }), { minScore: 0.2, relativeScore: 0.7 });
  assert.deepEqual(sourceRuleOf({ embeddingModel: 'Xenova/multilingual-e5-small', embeddingProfile: { pooling: 'mean' } }), { minScore: 0.2, relativeScore: 0.92 }, 'an older run without saved thresholds');
  assert.deepEqual(sourceRuleOf({ embeddingModel: 'Xenova/multilingual-e5-small', embeddingProfile: { sourceMinScore: 0.3, sourceRelativeScore: 0.8 } }), { minScore: 0.3, relativeScore: 0.8 }, 'saved thresholds win');
  // Scores 0.9 .. 0.75: the e5 rule (0.828) shows 2 chunks, the MiniLM rule (0.63) would show all four.
  const run = raw({ peakRssMb: 300 });
  run.meta.embeddingModel = 'Xenova/multilingual-e5-small';
  run.results = [{ id: 'a', lang: 'en', retrieved: [0.9, 0.85, 0.8, 0.75].map((score) => ({ source: 'x.txt', chunk: 0, score })) }];
  assert.deepEqual(summarizeRun(run).sourceFilter, { rule: { minScore: 0.2, relativeScore: 0.92 }, questions: 1, averageChunksShown: 2, allFourShown: 0, f1: null, f1WithMiniLmRule: null });
});

test('sourceRuleF1: F1 between the chunks shown and the chunks of the expected files, per answerable question', () => {
  const chunk = (source, score) => ({ source, chunk: 1, score });
  // Scores .9 (right file) .85 (other) .8 (right) .75 (other). The MiniLM rule (threshold 0.63) shows all four: precision 2/4,
  // recall 2/2, F1 2/3. At 0.92 x best (0.828) it shows the first two: 1/2 and 1/2, F1 0.5. At 0.95 x best (0.855) only the first: 1 and 1/2, F1 2/3.
  const results = [{ expectedSources: ['a.txt'], retrieved: [chunk('a.txt', 0.9), chunk('b.txt', 0.85), chunk('a.txt', 0.8), chunk('b.txt', 0.75)] }];
  assert.equal(sourceRuleF1(results, MINILM_RULE), 0.667);
  assert.equal(sourceRuleF1(results, { minScore: 0.2, relativeScore: 0.92 }), 0.5);
  assert.equal(sourceRuleF1(results, { minScore: 0.2, relativeScore: 0.95 }), 0.667);
  // A question with no expected file (unanswerable) is not part of it.
  assert.equal(sourceRuleF1([{ expectedSources: [], retrieved: [chunk('a.txt', 0.9)] }], MINILM_RULE), null);
});
