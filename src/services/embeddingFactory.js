/**
 * The embedder chosen by EMBEDDING_PROVIDER. Each provider is imported only when it is used, so with `google` the local
 * model code (Transformers.js and its native onnxruntime) is never loaded and costs no memory.
 * @param {{ embeddingProvider: 'local'|'google', embeddingModel: string, embeddingProfile: object, embeddingDtype: string, embeddingThreads: number, googleApiKey: string }} config
 * @returns {Promise<import('@langchain/core/embeddings').Embeddings>}
 */
export async function createEmbeddings(config) {
  if (config.embeddingProvider === 'google') {
    const { GoogleEmbeddings } = await import('./googleEmbeddings.js');
    return new GoogleEmbeddings({ apiKey: config.googleApiKey, model: config.embeddingModel, profile: config.embeddingProfile });
  }
  const { LocalEmbeddings } = await import('./embeddings.js');
  return new LocalEmbeddings({
    model: config.embeddingModel,
    dtype: config.embeddingDtype,
    threads: config.embeddingThreads,
    profile: config.embeddingProfile,
  });
}
