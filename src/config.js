import 'dotenv/config';

/**
 * Gemini "thinking" token budget. 0 (default) turns thinking off: answers use far fewer
 * tokens of the free quota. "default" leaves the model's own setting.
 */
function readThinkingBudget(value) {
  const text = value?.trim();
  if (!text) return 0;
  if (text.toLowerCase() === 'default') return null;
  const budget = Number(text);
  return Number.isInteger(budget) ? budget : 0;
}

const config = {
  port: Number(process.env.PORT) || 3000,
  googleApiKey: process.env.GOOGLE_API_KEY?.trim() || '',
  geminiModel: process.env.GEMINI_MODEL?.trim() || 'gemini-3.5-flash',
  geminiThinkingBudget: readThinkingBudget(process.env.GEMINI_THINKING_BUDGET),
  embeddingModel: process.env.EMBEDDING_MODEL?.trim() || 'Xenova/all-MiniLM-L6-v2',
  // q8 (quantized) and 1 thread keep memory low enough for 512 MB hosts.
  embeddingDtype: process.env.EMBEDDING_DTYPE?.trim() || 'q8',
  embeddingThreads: Number(process.env.EMBEDDING_THREADS) || 1,
  maxFileSizeMb: Number(process.env.MAX_FILE_SIZE_MB) || 10,
  // Each visitor has their own documents. Limits keep memory safe on small (512 MB) hosts.
  sessionTtlMinutes: Number(process.env.SESSION_TTL_MINUTES) || 30,
  maxSessions: Number(process.env.MAX_SESSIONS) || 100,
  maxDocsPerSession: 10,
  maxChunksPerSession: Number(process.env.MAX_CHUNKS_PER_SESSION) || 1500,
  maxTotalChunks: Number(process.env.MAX_TOTAL_CHUNKS) || 5000,
  chunkSize: 1000,
  chunkOverlap: 150,
  topK: 4,
  maxHistoryMessages: 6,
};

export default config;
