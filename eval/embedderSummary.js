// Turns one retrieval-only results file (eval/run.js) into the numbers of the embedder comparison. Pure.
import { wilson } from './score.js';

/** Peak process memory (MB) from which a model is flagged: Render's free plan has 512 MB. */
export const FLAG_RSS_MB = 450;

/** { k, n, share, low, high }: k hits out of n with the 95% Wilson interval (shares). */
function count(share, n) {
  const k = Math.round(share * n);
  const [low, high] = wilson(k, n);
  return { k, n, share: k / n, low, high };
}

/**
 * @param {{ meta: object, results: Array<{ lang: string, retrieved: Array<{ source: string, chunk: number }> }> }} raw
 */
export function summarizeRun(raw) {
  const { meta, results } = raw;
  const retrieval = {};
  for (const [name, g] of Object.entries(meta.summary)) {
    if (!g.answerable) continue;
    retrieval[name] = {
      n: g.answerable,
      hitAll: count(g.retrievalAll, g.answerable),
      hitAny: count(g.retrievalAny, g.answerable),
      top1: count(g.retrievalTop1, g.answerable),
      random: { topK: g.chance, top1: g.chanceTop1 },
    };
  }
  // Does one chunk come first for most questions of a language (the collapse the baseline shows in Arabic)?
  const top1Spread = {};
  for (const lang of ['en', 'ar']) {
    const firsts = results.filter((r) => r.lang === lang).map((r) => `${r.retrieved[0].source}#${r.retrieved[0].chunk}`);
    const counts = new Map();
    for (const first of firsts) counts.set(first, (counts.get(first) ?? 0) + 1);
    const [mostFrequent, times] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
    top1Spread[lang] = { questions: firsts.length, distinctChunks: counts.size, mostFrequent, times };
  }
  return {
    embeddingProfile: meta.embeddingProfile,
    retrieval,
    top1Spread,
    topScore: { answerable: meta.summary.all.topScoreAnswerable, unanswerable: meta.summary.all.topScoreUnanswerable },
    performance: meta.performance,
    nearLimit: (meta.performance?.peakRssMb ?? 0) >= FLAG_RSS_MB,
  };
}
