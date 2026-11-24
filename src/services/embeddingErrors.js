import { HttpError } from '../utils/httpError.js';

/** The embedding settings do not fit the model (dimensions too large, no sentence_embedding output, unknown model id, ...). */
export class EmbeddingConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EmbeddingConfigError';
  }
}

/**
 * Turn an embedding failure into the HttpError the visitor sees. A settings problem says which .env settings to check;
 * a real load failure (no internet for the first download, ...) keeps the connectivity message. An HttpError that was
 * already written for the user passes through.
 * @param {unknown} error
 * @param {{ model: string }} context
 */
export function toEmbeddingHttpError(error, { model }) {
  if (error instanceof HttpError) return error;
  if (error instanceof EmbeddingConfigError) {
    return new HttpError(503, 'EMBEDDING_CONFIG', `The embedding settings do not fit the model "${model}": ${error.message} Check EMBEDDING_MODEL, EMBEDDING_POOLING and EMBEDDING_DIMENSIONS in .env.`);
  }
  return new HttpError(503, 'EMBEDDING_FAILED', `The embedding model "${model}" could not be loaded. Check your internet connection (needed once to download it) and the EMBEDDING_MODEL setting in .env, then try again.`);
}
