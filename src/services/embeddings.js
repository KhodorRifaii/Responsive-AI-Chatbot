import { Embeddings } from '@langchain/core/embeddings';
import { pipeline, env } from '@huggingface/transformers';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Cache downloaded model files inside the project (ignored by git).
env.cacheDir = path.join(__dirname, '..', '..', '.cache', 'models');

/**
 * Free, local sentence embeddings (Transformers.js, runs on CPU).
 * The model is downloaded once from the Hugging Face Hub, then cached.
 */
export class LocalEmbeddings extends Embeddings {
  constructor({ model = 'Xenova/all-MiniLM-L6-v2', batchSize = 16, ...rest } = {}) {
    super(rest);
    this.model = model;
    this.batchSize = batchSize;
    this.extractorPromise = null;
  }

  getExtractor() {
    if (!this.extractorPromise) {
      this.extractorPromise = pipeline('feature-extraction', this.model, { dtype: 'fp32' })
        .catch((error) => {
          this.extractorPromise = null;
          throw error;
        });
    }
    return this.extractorPromise;
  }

  async embedDocuments(texts) {
    const extractor = await this.getExtractor();
    const vectors = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const output = await extractor(batch, { pooling: 'mean', normalize: true });
      vectors.push(...output.tolist());
    }
    return vectors;
  }

  async embedQuery(text) {
    const [vector] = await this.embedDocuments([text]);
    return vector;
  }
}
