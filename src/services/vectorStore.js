import { randomUUID } from 'node:crypto';
import { MemoryVectorStore } from '@langchain/classic/vectorstores/memory';
import { LocalEmbeddings } from './embeddings.js';
import { loadAndSplit } from './documentLoader.js';
import config from '../config.js';
import { HttpError } from '../utils/httpError.js';
import { toEmbeddingHttpError } from './embeddingErrors.js';

// One embedding model for everyone; each visitor gets their own vector store.
export const embeddings = new LocalEmbeddings({
  model: config.embeddingModel,
  dtype: config.embeddingDtype,
  threads: config.embeddingThreads,
  profile: config.embeddingProfile,
});

/**
 * Sessions by id. Each holds its own documents and vector store, so visitors
 * never see or search each other's files.
 * @type {Map<string, { id: string, store: MemoryVectorStore, documents: Map<string, object>, chunks: number, lastSeen: number }>}
 */
const sessions = new Map();
let totalChunks = 0;

const ttlMs = () => config.sessionTtlMinutes * 60 * 1000;

function freeSession(id) {
  const session = sessions.get(id);
  if (!session) return;
  totalChunks -= session.chunks;
  sessions.delete(id);
}

/** Remove sessions with no activity for longer than the time limit. */
export function removeExpiredSessions(now = Date.now()) {
  for (const [id, session] of sessions) {
    if (now - session.lastSeen > ttlMs()) freeSession(id);
  }
}

// Check for idle sessions every minute; unref() lets the process exit normally.
setInterval(removeExpiredSessions, 60 * 1000).unref();

/** Existing session for this id (and mark it active), or null. */
export function getSession(id) {
  const session = id ? sessions.get(id) : null;
  if (!session) return null;
  if (Date.now() - session.lastSeen > ttlMs()) {
    freeSession(id);
    return null;
  }
  session.lastSeen = Date.now();
  return session;
}

export function createSession() {
  if (sessions.size >= config.maxSessions) removeExpiredSessions();
  if (sessions.size >= config.maxSessions) {
    throw new HttpError(503, 'SERVER_BUSY', 'Too many people are using the chatbot right now. Please try again in a few minutes.');
  }
  const session = {
    id: randomUUID(),
    store: new MemoryVectorStore(embeddings),
    documents: new Map(),
    chunks: 0,
    lastSeen: Date.now(),
  };
  sessions.set(session.id, session);
  return session;
}

// Chunks embedded per progress step. The model still embeds one at a time (memory stays flat).
const EMBED_STEP = 16;
const PROGRESS_INTERVAL_MS = 200;

/** Calls onProgress at most every 200 ms, except for forced (stage change, last step) updates. */
function progressReporter(onProgress) {
  let last = 0;
  return (progress, force = false) => {
    if (!onProgress) return;
    const now = Date.now();
    if (!force && now - last < PROGRESS_INTERVAL_MS) return;
    last = now;
    onProgress(progress);
  };
}

/**
 * Parse, split and embed one file into the session's store.
 * onProgress({ stage: 'reading' | 'embedding', done, total }) reports how far it got.
 */
export async function addDocument(session, file, { onProgress } = {}) {
  if (session.documents.size >= config.maxDocsPerSession) {
    throw new HttpError(409, 'TOO_MANY_DOCUMENTS', `You can have up to ${config.maxDocsPerSession} documents at a time. Your documents are cleared after ${config.sessionTtlMinutes} minutes without activity.`);
  }

  const report = progressReporter(onProgress);
  report({ stage: 'reading', done: 0, total: 0 }, true);
  const id = randomUUID();
  const chunks = await loadAndSplit(file, id);

  if (session.chunks + chunks.length > config.maxChunksPerSession) {
    const room = Math.max(0, config.maxChunksPerSession - session.chunks);
    throw new HttpError(413, 'DOCUMENT_TOO_LARGE', `"${file.originalname}" is too long to add (${chunks.length} parts, room for ${room}). Try a shorter file.`);
  }
  if (totalChunks + chunks.length > config.maxTotalChunks) {
    throw new HttpError(503, 'SERVER_BUSY', 'The server is full right now. Please try again in a few minutes.');
  }

  // A session that expired during an earlier (slow) file of the same upload must not reserve
  // space again: it was already freed, so the reservation would never be given back.
  if (sessions.get(session.id) !== session) {
    throw new HttpError(410, 'SESSION_EXPIRED', 'Your session expired. Please upload the file again.');
  }
  // Reserve the space before the slow embedding step so parallel uploads can't overshoot the limits.
  session.chunks += chunks.length;
  totalChunks += chunks.length;
  try {
    // Embed in steps to report progress, then add all vectors at once: a failure adds nothing.
    const texts = chunks.map((chunk) => chunk.pageContent);
    const vectors = [];
    report({ stage: 'embedding', done: 0, total: texts.length }, true);
    for (let i = 0; i < texts.length; i += EMBED_STEP) {
      vectors.push(...await embeddings.embedDocuments(texts.slice(i, i + EMBED_STEP)));
      report({ stage: 'embedding', done: vectors.length, total: texts.length }, vectors.length === texts.length);
    }
    await session.store.addVectors(vectors, chunks);
  } catch (error) {
    session.chunks -= chunks.length;
    // freeSession() already gave back this session's whole reservation if it expired meanwhile.
    if (sessions.get(session.id) === session) totalChunks -= chunks.length;
    console.error('Embedding failed:', error);
    throw toEmbeddingHttpError(error, { model: config.embeddingModel });
  }

  // The session may have expired while a long file was being embedded.
  if (sessions.get(session.id) !== session) {
    throw new HttpError(410, 'SESSION_EXPIRED', 'Your session expired. Please upload the file again.');
  }

  const info = {
    id,
    name: file.originalname,
    size: file.size,
    chunks: chunks.length,
    uploadedAt: new Date().toISOString(),
  };
  session.documents.set(id, info);
  session.lastSeen = Date.now();
  return info;
}

export function listDocuments(session) {
  return session ? [...session.documents.values()] : [];
}

export function hasDocuments(session) {
  return Boolean(session && session.documents.size > 0);
}

/** Top-k chunks of this session's documents with their cosine similarity score: [[Document, score], ...] */
export async function search(session, query, k = config.topK) {
  try {
    return await session.store.similaritySearchWithScore(query, k);
  } catch (error) {
    console.error('Search failed:', error);
    throw toEmbeddingHttpError(error, { model: config.embeddingModel });
  }
}

/** Numbers for tests and logs. */
export function getStats() {
  return { sessions: sessions.size, totalChunks };
}
