import { randomUUID } from 'node:crypto';
import { MemoryVectorStore } from '@langchain/classic/vectorstores/memory';
import { LocalEmbeddings } from './embeddings.js';
import { loadAndSplit } from './documentLoader.js';
import config from '../config.js';

const embeddings = new LocalEmbeddings({ model: config.embeddingModel });
const store = new MemoryVectorStore(embeddings);

/** Uploaded documents for this server session, newest last. */
const documents = new Map();

export async function addDocument(file) {
  const id = randomUUID();
  const chunks = await loadAndSplit(file, id);
  await store.addDocuments(chunks);

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

export async function search(query, k = config.topK) {
  return store.similaritySearch(query, k);
}
