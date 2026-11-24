// How each embedding model must be called: pooling, normalisation, query/document prefixes and size.
// A model that is used without its own prefixes or pooling still runs, but retrieves worse, so
// models verified against their model cards are listed here; any other model gets the plain
// defaults (mean pooling, no prefixes) plus a warning, and the EMBEDDING_* settings can override.
import { EmbeddingConfigError } from './embeddingErrors.js';

/**
 * Verified models (lowercase id). pooling 'model' means the model's own ONNX graph pools and
 * projects the vector and returns it as `sentence_embedding` (EmbeddingGemma); it is only valid here.
 * Sources: the model cards of intfloat/multilingual-e5-*, onnx-community/embeddinggemma-300m-ONNX and
 * Qwen/Qwen3-Embedding-0.6B (+ its ONNX port), checked 2026-11-24.
 */
const KNOWN = {
  'xenova/all-minilm-l6-v2': { pooling: 'mean', queryPrefix: '', documentPrefix: '', nativeDimensions: 384 },
  'xenova/multilingual-e5-small': { pooling: 'mean', queryPrefix: 'query: ', documentPrefix: 'passage: ', nativeDimensions: 384 },
  'xenova/multilingual-e5-base': { pooling: 'mean', queryPrefix: 'query: ', documentPrefix: 'passage: ', nativeDimensions: 768 },
  'onnx-community/embeddinggemma-300m-onnx': { pooling: 'model', queryPrefix: 'task: search result | query: ', documentPrefix: 'title: none | text: ', nativeDimensions: 768 },
  // The card asks for "Instruct: <one-sentence task>\nQuery:<question>" on queries and nothing on documents.
  'onnx-community/qwen3-embedding-0.6b-onnx': {
    pooling: 'last_token',
    queryPrefix: 'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:',
    documentPrefix: '',
    nativeDimensions: 1024,
  },
};

/** Poolings a user may choose through EMBEDDING_POOLING ('model' is table-only). */
const POOLINGS = ['mean', 'cls', 'last_token'];

/** A prefix from the environment: a literal backslash-n becomes a newline; never trimmed (the trailing space matters). */
const readPrefix = (value, fallback) => (value === undefined ? fallback : value.replaceAll('\\n', '\n'));

/**
 * The embedding profile for a model, with the EMBEDDING_* overrides applied. Pure; never throws.
 * Problems (unknown model, a value that was ignored) come back in `warnings` for the caller to print.
 * @param {string} model
 * @param {Record<string, string | undefined>} env
 * @returns {{ pooling: 'mean'|'cls'|'last_token'|'model', normalize: boolean, queryPrefix: string, documentPrefix: string, dimensions: number|null, nativeDimensions: number|null, known: boolean, warnings: string[] }}
 */
export function resolveEmbeddingProfile(model, env = {}) {
  const entry = KNOWN[String(model).toLowerCase()];
  const warnings = [];
  if (!entry) {
    warnings.push(`Embedding model ${model} has no verified profile: using mean pooling and no prefixes. Set EMBEDDING_POOLING, EMBEDDING_QUERY_PREFIX and EMBEDDING_DOCUMENT_PREFIX if its model card says otherwise.`);
  }
  const base = entry ?? { pooling: 'mean', queryPrefix: '', documentPrefix: '', nativeDimensions: null };

  let pooling = base.pooling;
  const requestedPooling = env.EMBEDDING_POOLING?.trim().toLowerCase();
  if (requestedPooling) {
    if (POOLINGS.includes(requestedPooling)) pooling = requestedPooling;
    else warnings.push(`EMBEDDING_POOLING=${env.EMBEDDING_POOLING} ignored (use mean, cls or last_token): using ${pooling}.`);
  }

  let dimensions = null;
  const requestedDimensions = env.EMBEDDING_DIMENSIONS?.trim();
  if (requestedDimensions) {
    const number = Number(requestedDimensions);
    const fits = Number.isInteger(number) && number > 0 && (base.nativeDimensions === null || number <= base.nativeDimensions);
    if (fits) dimensions = number;
    else warnings.push(`EMBEDDING_DIMENSIONS=${requestedDimensions} ignored (use a whole number from 1${base.nativeDimensions ? ` to ${base.nativeDimensions}` : ''}): using the full vector.`);
  }

  return {
    pooling,
    normalize: true,
    queryPrefix: readPrefix(env.EMBEDDING_QUERY_PREFIX, base.queryPrefix),
    documentPrefix: readPrefix(env.EMBEDDING_DOCUMENT_PREFIX, base.documentPrefix),
    dimensions,
    nativeDimensions: base.nativeDimensions,
    known: Boolean(entry),
    warnings,
  };
}

/**
 * Keep the first `dimensions` values (Matryoshka-style truncation) and scale the vector back to length 1.
 * null = leave the vector alone (the same array).
 */
export function truncateAndNormalize(vector, dimensions) {
  if (dimensions === null) return vector;
  if (vector.length < dimensions) throw new EmbeddingConfigError(`EMBEDDING_DIMENSIONS asks for ${dimensions} values but the model returned only ${vector.length}.`);
  const cut = vector.slice(0, dimensions);
  const norm = Math.hypot(...cut);
  return norm === 0 ? cut : cut.map((value) => value / norm);
}
