import { Embeddings } from '@langchain/core/embeddings';
import { pipeline, env, AutoTokenizer, AutoModel } from '@huggingface/transformers';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveEmbeddingProfile, truncateAndNormalize } from './embeddingProfile.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Cache downloaded model files inside the project (ignored by git).
env.cacheDir = path.join(__dirname, '..', '..', '.cache', 'models');

/**
 * Pipeline settings for models that pool inside their own ONNX graph and return `sentence_embedding`
 * (EmbeddingGemma). `pipeline('feature-extraction')` would only return the raw token vectors for them.
 * Returns a function with the same shape as the pipeline: (texts) => tensor with tolist().
 */
async function loadSentenceEmbeddingExtractor(model, options) {
  const [tokenizer, network] = await Promise.all([AutoTokenizer.from_pretrained(model), AutoModel.from_pretrained(model, options)]);
  return async (texts) => {
    const outputs = await network(tokenizer(texts, { padding: true, truncation: true }));
    if (!outputs.sentence_embedding) throw new Error(`Embedding model ${model} returned no sentence_embedding output, so pooling "model" cannot be used with it.`);
    return outputs.sentence_embedding;
  };
}

/**
 * Free, local sentence embeddings (Transformers.js, runs on CPU).
 * The model is downloaded once from the Hugging Face Hub, then cached.
 * `profile` says how the model must be called (pooling, query/document prefixes, size); see embeddingProfile.js.
 */
export class LocalEmbeddings extends Embeddings {
  // batchSize 1: onnxruntime keeps the memory of its biggest batch, so small batches keep
  // memory flat (~350 MB for 1,400 parts vs ~1 GB with 16) at the same speed.
  // loadExtractor replaces the model loading (tests use a fake).
  constructor({ model = 'Xenova/all-MiniLM-L6-v2', dtype = 'q8', threads = 1, batchSize = 1, profile = resolveEmbeddingProfile(model), loadExtractor = null, ...rest } = {}) {
    super(rest);
    this.model = model;
    this.dtype = dtype;
    this.threads = threads;
    this.batchSize = batchSize;
    this.profile = profile;
    this.loadExtractor = loadExtractor;
    this.extractorPromise = null;
  }

  getExtractor() {
    if (!this.extractorPromise) {
      const options = { dtype: this.dtype, session_options: { intraOpNumThreads: this.threads, interOpNumThreads: 1 } };
      const load = this.loadExtractor
        ? this.loadExtractor()
        : this.profile.pooling === 'model'
          ? loadSentenceEmbeddingExtractor(this.model, options)
          : pipeline('feature-extraction', this.model, options);
      this.extractorPromise = Promise.resolve(load)
        .catch((error) => {
          this.extractorPromise = null;
          throw error;
        });
    }
    return this.extractorPromise;
  }

  /** Embeds the texts as they are (the prefix, if any, is already part of them). */
  async embed(texts) {
    const extractor = await this.getExtractor();
    const { pooling, normalize, dimensions } = this.profile;
    const vectors = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const output = await extractor(batch, { pooling, normalize });
      vectors.push(...output.tolist().map((vector) => this.shape(vector, dimensions)));
    }
    return vectors;
  }

  /** Cut to EMBEDDING_DIMENSIONS if set. */
  shape(vector, dimensions) {
    if (dimensions !== null && vector.length < dimensions) {
      throw new Error(`Embedding model ${this.model} returned only ${vector.length} values, but EMBEDDING_DIMENSIONS asks for ${dimensions}.`);
    }
    return truncateAndNormalize(vector, dimensions);
  }

  embedDocuments(texts) {
    const { documentPrefix } = this.profile;
    return this.embed(documentPrefix ? texts.map((text) => documentPrefix + text) : texts);
  }

  async embedQuery(text) {
    const { queryPrefix } = this.profile;
    const [vector] = await this.embed([queryPrefix + text]);
    return vector;
  }
}
