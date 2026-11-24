// Turns one retrieval-only results file (eval/run.js) into the numbers of the embedder comparison. Pure.
import { wilson } from './score.js';
import { resolveEmbeddingProfile } from '../src/services/embeddingProfile.js';

/** Peak process memory (MB) from which a model is flagged: Render's free plan has 512 MB. */
export const FLAG_RSS_MB = 450;

/** { k, n, share, low, high }: k hits out of n with the 95% Wilson interval (shares). */
function count(share, n) {
  const k = Math.round(share * n);
  const [low, high] = wilson(k, n);
  return { k, n, share: k / n, low, high };
}

/**
 * The source-filter rule of a stored run: the thresholds saved in its embedding profile, or (runs from before they were saved)
 * those of the model's profile.
 */
export function sourceRuleOf(meta) {
  const profile = meta.embeddingProfile ?? {};
  const resolved = resolveEmbeddingProfile(meta.embeddingModel ?? '', {});
  return { minScore: profile.sourceMinScore ?? resolved.sourceMinScore, relativeScore: profile.sourceRelativeScore ?? resolved.sourceRelativeScore };
}

/** The rule the app used for every model before it moved into the embedding profile. */
export const MINILM_RULE = { minScore: 0.2, relativeScore: 0.7 };

/**
 * How well a source rule picks the chunks to show, over the answerable questions: for each question the F1 between the chunks
 * shown (score at least max(min, relative x best)) and the retrieved chunks that come from an expected file, averaged.
 * 1 = shows exactly the right-file chunks; a rule that shows everything gets low precision, one that shows too little low recall.
 * @param {Array<{ expectedSources: string[], retrieved: Array<{ source: string, score: number }> }>} results
 */
export function sourceRuleF1(results, rule) {
  const answerable = results.filter((r) => r.expectedSources?.length && r.retrieved.length);
  if (answerable.length === 0) return null;
  const total = answerable.reduce((sum, r) => {
    const threshold = Math.max(rule.minScore, r.retrieved[0].score * rule.relativeScore);
    const shown = r.retrieved.filter((x) => x.score >= threshold);
    const right = r.retrieved.filter((x) => r.expectedSources.includes(x.source));
    const hits = shown.filter((x) => r.expectedSources.includes(x.source)).length;
    const precision = shown.length ? hits / shown.length : 0;
    const recall = right.length ? hits / right.length : 1;
    return sum + (precision + recall ? (2 * precision * recall) / (precision + recall) : 0);
  }, 0);
  return Math.round((total / answerable.length) * 1000) / 1000;
}

/**
 * @param {{ meta: object, results: Array<{ lang: string, retrieved: Array<{ source: string, chunk: number, score: number }> }> }} raw
 * @param {{ minScore: number, relativeScore: number }} [sourceRule] the app's rule for the sources it shows when the model cites none (default: the run's own, see sourceRuleOf)
 */
export function summarizeRun(raw, sourceRule = sourceRuleOf(raw.meta)) {
  const { meta, results } = raw;
  const retrieval = {};
  for (const [name, g] of Object.entries(meta.summary)) {
    if (!g.answerable) continue;
    retrieval[name] = {
      n: g.answerable,
      hitAll: count(g.retrievalAll, g.answerable),
      hitAny: count(g.retrievalAny, g.answerable),
      top1: count(g.retrievalTop1, g.answerable),
      // Every gold fact in a retrieved chunk of an expected file (absent in runs scored before the metric existed).
      ...(g.retrievalChunk === null || g.retrievalChunk === undefined ? {} : { hitChunk: count(g.retrievalChunk, g.answerable) }),
      random: { topK: g.chance, top1: g.chanceTop1 },
    };
  }
  // Does one chunk come first for most questions of a language (the collapse the baseline shows in Arabic)?
  const top1Spread = {};
  for (const lang of ['en', 'ar']) {
    const firsts = results.filter((r) => r.lang === lang).map((r) => (r.retrieved[0] ? `${r.retrieved[0].source}#${r.retrieved[0].chunk}` : '(nothing retrieved)'));
    const counts = new Map();
    for (const first of firsts) counts.set(first, (counts.get(first) ?? 0) + 1);
    const [mostFrequent, times] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
    top1Spread[lang] = { questions: firsts.length, distinctChunks: counts.size, mostFrequent, times };
  }
  // The app shows the chunks scoring at least max(minScore, relativeScore x best) when the model cites nothing.
  // A model whose scores are squeezed into a narrow band (e5: 0.8-0.9) lets every chunk pass, so no source is filtered out.
  const shown = results.map((r) => {
    const threshold = Math.max(sourceRule.minScore, (r.retrieved[0]?.score ?? 0) * sourceRule.relativeScore);
    return r.retrieved.filter((x) => x.score >= threshold).length;
  });
  const sourceFilter = {
    rule: { minScore: sourceRule.minScore, relativeScore: sourceRule.relativeScore },
    questions: shown.length,
    averageChunksShown: Math.round((shown.reduce((a, b) => a + b, 0) / shown.length) * 100) / 100,
    allFourShown: shown.filter((n) => n === 4).length,
    // Answerable questions only: how well the chunks shown match the right files, with this rule and with MiniLM's 0.2 / 0.7.
    f1: sourceRuleF1(results, sourceRule),
    f1WithMiniLmRule: sourceRuleF1(results, MINILM_RULE),
  };
  return {
    embeddingProfile: meta.embeddingProfile,
    retrieval,
    top1Spread,
    sourceFilter,
    topScore: { answerable: meta.summary.all.topScoreAnswerable, unanswerable: meta.summary.all.topScoreUnanswerable },
    performance: meta.performance,
    nearLimit: (meta.performance?.peakRssMb ?? 0) >= FLAG_RSS_MB,
  };
}
