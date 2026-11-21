import { randomUUID } from 'node:crypto';
import { MemoryVectorStore } from '@langchain/classic/vectorstores/memory';
import { LocalEmbeddings } from './embeddings.js';
import { loadAndSplit } from './documentLoader.js';
import config from '../config.js';
import { HttpError } from '../utils/httpError.js';

const embeddings = new LocalEmbeddings({ model: config.embeddingModel });
const store = new MemoryVectorStore(embeddings);

/** Uploaded documents for this server session, newest last. */
const documents = new Map();

export async function addDocument(file) {
  const id = randomUUID();
  const chunks = await loadAndSplit(file, id);
  try {
    await store.addDocuments(chunks);
  } catch (error) {
    console.error('Embedding failed:', error);
    throw new HttpError(503, 'EMBEDDING_FAILED', 'The embedding model could not be loaded. Check your internet connection (needed once to download it) and try again.');
  }

  const info = {
    id,
    name: file.originalname,
    size: file.size,
    chunks: chunks.length,
    uploadedAt: new Date().toISOString(),
  };
  documents.set(id, info);
  return info;
}

export function listDocuments() {
  return [...documents.values()];
}

export function hasDocuments() {
  return documents.size > 0;
}

/** Top-k chunks with their cosine similarity score: [[Document, score], ...] */
export async function search(query, k = config.topK) {
  return store.similaritySearchWithScore(query, k);
}
