import { Embeddings } from '@langchain/core/embeddings';
import { HttpError } from '../utils/httpError.js';
import { EmbeddingAuthError, EmbeddingConfigError, EmbeddingQuotaError, EmbeddingUnavailableError } from './embeddingErrors.js';

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const KEY_LIKE = /AIza[0-9A-Za-z_-]{10,}/g;
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Hosted embeddings from Google (Gemini API, plain `fetch`, no SDK). The model never runs in this process, so memory stays low.
 *
 * - gemini-embedding-2 takes the task as a text prefix, gemini-embedding-001 as a `taskType`: both come from the embedding profile.
 * - Documents go in batches of `batchSize` (batchEmbedContents), one after the other; the result is complete or an error, never partial.
 * - 429 / 500 / 502 / 503 / 504 and network errors are retried up to `maxAttempts` with exponential backoff (or Retry-After, capped), but
 *   every call, waits included, ends within `budgetMs`. A wrong key (Google answers HTTP 400 API_KEY_INVALID), a bad setting (other 400, 404)
 *   and answers that cannot be used are not retried.
 * - The key travels only in the `x-goog-api-key` header; nothing here logs it, and messages from Google are scrubbed before they are kept.
 * - Every vector is scaled to length 1 (required for gemini-embedding-001 with a reduced size, harmless for gemini-embedding-2).
 * `fetch`, `sleep`, `now` and `random` can be replaced (tests).
 */
export class GoogleEmbeddings extends Embeddings {
  constructor({ apiKey, model, profile, fetch = globalThis.fetch, baseUrl = BASE_URL, batchSize = 16, maxAttempts = 3, timeoutMs = 8000, budgetMs = 20000, maxRetryAfterMs = 5000, backoffMs = 500, sleep = defaultSleep, now = () => performance.now(), random = Math.random, ...rest } = {}) {
    super(rest);
    this.apiKey = apiKey?.trim() ?? '';
    this.model = model;
    this.profile = profile;
    this.fetch = fetch;
    this.baseUrl = baseUrl;
    this.batchSize = batchSize;
    this.maxAttempts = maxAttempts;
    this.timeoutMs = timeoutMs;
    this.budgetMs = budgetMs;
    this.maxRetryAfterMs = maxRetryAfterMs;
    this.backoffMs = backoffMs;
    this.sleep = sleep;
    this.now = now;
    this.random = random;
    /** Real HTTP calls, retries, embedded texts and answers by status: what the eval reports as "API calls". */
    this.stats = { requests: 0, retries: 0, texts: 0, byStatus: {} };
  }

  /** Text for a message or log: Google's wording without anything that looks like a key (including this one), short. */
  scrub(text) {
    let clean = String(text ?? '');
    if (this.apiKey) clean = clean.split(this.apiKey).join('[key]');
    return clean.replace(KEY_LIKE, '[key]').replace(/\s+/g, ' ').slice(0, 200);
  }

  /** The part of one request that is the same for a query and a document. */
  content(text, kind) {
    const { queryPrefix, documentPrefix, taskTypes, dimensions } = this.profile;
    const prefix = kind === 'query' ? queryPrefix : documentPrefix;
    return {
      model: `models/${this.model}`,
      content: { parts: [{ text: prefix ? prefix + text : text }] },
      ...(taskTypes ? { taskType: taskTypes[kind] } : {}),
      ...(dimensions ? { outputDimensionality: dimensions } : {}),
    };
  }

  /** One POST with the retry rules above. Resolves to the parsed answer. */
  async post(method, body) {
    if (!this.apiKey) {
      throw new HttpError(503, 'MISSING_API_KEY', 'The AI is not set up yet: add GOOGLE_API_KEY to the .env file and restart the server. You can get a free key at aistudio.google.com.');
    }
    const started = this.now();
    let failure = null;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const left = this.budgetMs - (this.now() - started);
      if (left <= 0) break;
      this.stats.requests += 1;
      failure = null;
      let response;
      try {
        response = await this.fetch(`${this.baseUrl}/models/${this.model}:${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(Math.max(1, Math.min(this.timeoutMs, left))),
        });
      } catch (error) {
        failure = { status: 0, message: `${error?.name ?? 'Error'}: ${this.scrub(error?.message)}`, retryAfterMs: null };
      }
      if (response) {
        this.stats.byStatus[response.status] = (this.stats.byStatus[response.status] ?? 0) + 1;
        const text = await response.text().catch(() => '');
        let payload = null;
        try {
          payload = JSON.parse(text);
        } catch {
          // Not JSON: handled below.
        }
        if (response.ok) {
          if (payload) return payload;
          throw new EmbeddingUnavailableError('Google sent an answer that could not be read.');
        }
        const reason = payload?.error?.details?.map((detail) => detail?.reason).find(Boolean) ?? '';
        const message = this.scrub(payload?.error?.message ?? text);
        this.throwIfFinal(response.status, reason, message);
        const retryAfter = Number(response.headers.get('retry-after'));
        failure = { status: response.status, message, retryAfterMs: Number.isFinite(retryAfter) && retryAfter >= 0 && response.headers.has('retry-after') ? retryAfter * 1000 : null };
      }
      const wait = Math.min(failure.retryAfterMs ?? this.backoffMs * 2 ** (attempt - 1) * (1 + this.random() * 0.2), this.maxRetryAfterMs);
      // Another attempt only if its wait still fits in the budget.
      if (attempt === this.maxAttempts || this.now() - started + wait >= this.budgetMs) break;
      this.stats.retries += 1;
      await this.sleep(wait);
    }
    const detail = failure ? `${failure.status || 'no answer'} ${failure.message}` : 'no time left';
    if (failure?.status === 429) throw new EmbeddingQuotaError(`Google's embedding quota was reached (${detail}).`);
    throw new EmbeddingUnavailableError(`Google's embedding service did not answer (${detail}).`);
  }

  /** Errors that no retry can fix: a wrong key, a setting Google does not accept, an unknown model. */
  throwIfFinal(status, reason, message) {
    // Google answers a wrong API key with HTTP 400 and reason API_KEY_INVALID, not 401/403.
    if (status === 401 || status === 403 || reason === 'API_KEY_INVALID' || /api key not valid/i.test(message)) {
      throw new EmbeddingAuthError(`Google rejected the API key (${status}).`);
    }
    if (status === 400 || status === 404) throw new EmbeddingConfigError(`Google rejected the request for "${this.model}" (${status}: ${message}).`);
    if (!RETRYABLE_STATUS.has(status)) throw new EmbeddingUnavailableError(`Google answered ${status}: ${message}`);
  }

  /** Checks one vector (right size, finite numbers, not all zero) and scales it to length 1. */
  clean(values, expected) {
    if (!Array.isArray(values) || values.length === 0 || values.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
      throw new EmbeddingUnavailableError('Google sent a vector that cannot be used.');
    }
    if (expected && values.length !== expected) {
      throw new EmbeddingConfigError(`Google returned ${values.length} values per vector but EMBEDDING_DIMENSIONS asks for ${expected}.`);
    }
    const length = Math.hypot(...values);
    if (length === 0) throw new EmbeddingUnavailableError('Google sent an all-zero vector.');
    return values.map((value) => value / length);
  }

  async embedQuery(text) {
    const answer = await this.post('embedContent', this.content(text, 'query'));
    this.stats.texts += 1;
    return this.clean(answer?.embedding?.values, this.profile.dimensions);
  }

  async embedDocuments(texts) {
    const vectors = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const answer = await this.post('batchEmbedContents', { requests: batch.map((text) => this.content(text, 'document')) });
      const returned = answer?.embeddings;
      if (!Array.isArray(returned) || returned.length !== batch.length) {
        throw new EmbeddingUnavailableError(`Google returned ${Array.isArray(returned) ? returned.length : 'no'} vectors for ${batch.length} texts.`);
      }
      this.stats.texts += batch.length;
      for (const item of returned) vectors.push(this.clean(item?.values, this.profile.dimensions));
    }
    return vectors;
  }
}
