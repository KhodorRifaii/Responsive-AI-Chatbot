import { HttpError } from '../utils/httpError.js';

/** The embedding settings do not fit the model (dimensions too large, no sentence_embedding output, unknown model id, ...). */
export class EmbeddingConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EmbeddingConfigError';
  }
}

/** The hosted embedding service rejected the API key. */
export class EmbeddingAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EmbeddingAuthError';
  }
}

/** The hosted embedding service is out of quota (HTTP 429), also after the capped retries. */
export class EmbeddingQuotaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EmbeddingQuotaError';
  }
}

/** The hosted embedding service could not be reached, was busy or sent an answer that cannot be used, also after the capped retries. */
export class EmbeddingUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EmbeddingUnavailableError';
  }
}

/**
 * Turn an embedding failure into the HttpError the visitor sees. A settings problem says which .env settings to check;
 * a real load failure (no internet for the first download, ...) keeps the connectivity message. An HttpError that was
 * already written for the user (for example MISSING_API_KEY) passes through. The messages never contain the raw provider text.
 * @param {unknown} error
 * @param {{ model: string, provider?: 'local' | 'google' }} context
 */
export function toEmbeddingHttpError(error, { model, provider = 'local' }) {
  if (error instanceof HttpError) return error;
  if (error instanceof EmbeddingConfigError) {
    const settings = provider === 'google' ? 'EMBEDDING_PROVIDER, EMBEDDING_MODEL and EMBEDDING_DIMENSIONS' : 'EMBEDDING_MODEL, EMBEDDING_POOLING and EMBEDDING_DIMENSIONS';
    return new HttpError(503, 'EMBEDDING_CONFIG', `The embedding settings do not fit the model "${model}": ${error.message} Check ${settings} in .env.`);
  }
  if (error instanceof EmbeddingAuthError) {
    return new HttpError(502, 'EMBEDDING_AUTH', 'Google rejected the API key for embeddings. Check GOOGLE_API_KEY in your .env file.');
  }
  if (error instanceof EmbeddingQuotaError) {
    return new HttpError(429, 'EMBEDDING_RATE_LIMIT', 'The free Google limit for embeddings was reached (it is shared with the chat answers). Wait a minute and try again.');
  }
  if (provider === 'google') {
    return new HttpError(503, 'EMBEDDING_FAILED', 'Google\'s embedding service could not be reached or is busy right now. Please try again in a moment.');
  }
  return new HttpError(503, 'EMBEDDING_FAILED', `The embedding model "${model}" could not be loaded. Check your internet connection (needed once to download it) and the EMBEDDING_MODEL setting in .env, then try again.`);
}
