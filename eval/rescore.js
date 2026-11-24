// Adds the chunk-level retrieval score to an already stored results file, without running a model:
// the retrieved chunks are stored as source + chunk number and the chunking is deterministic.
import { chunkHit, summarize } from './score.js';

/**
 * Returns a copy of the stored run (eval/run.js results file) whose answerable questions have `score.retrievalChunk`,
 * with `meta.summary` recomputed from the scored records. Everything else is left as it was.
 * @param {{ meta: object, results: Array<{ id: string, score: object, retrieved: Array<{ source: string, chunk: number }> }> }} raw
 * @param {Array<{ id: string, sources: string[], facts: string[][], lang: string, type: string }>} questions
 */
export function addChunkLevel(raw, questions, chunkText) {
  const byId = new Map(questions.map((q) => [q.id, q]));
  const results = raw.results.map((r) => {
    const question = byId.get(r.id);
    if (!question) throw new Error(`question ${r.id} of the results file is not in questions.jsonl`);
    return question.sources.length ? { ...r, score: { ...r.score, retrievalChunk: chunkHit(question, r.retrieved, chunkText) } } : r;
  });
  return { meta: { ...raw.meta, summary: summarize(questions, results.map((r) => r.score)) }, results };
}
