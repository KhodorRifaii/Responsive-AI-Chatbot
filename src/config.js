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

/**
 * Express "trust proxy": how many proxies sit in front of the app. 1 (default) fits Render.
 * "false" when the app is reached directly (no proxy), so X-Forwarded-For is ignored.
 * Also accepts a hop count or a list of trusted addresses ("loopback, 10.0.0.0/8").
 */
function readTrustProxy(value) {
  const text = value?.trim();
  if (!text) return 1;
  if (text === 'false') return false;
  return /^\d+$/.test(text) ? Number(text) : text;
}

/**
 * Second Gemini model, used when the main one is out of quota, overloaded, too slow or retired.
 * "none" (or the same name as the main model) turns the fallback off.
 */
function readFallbackModel(value, mainModel) {
  const text = value?.trim();
  if (text?.toLowerCase() === 'none') return null;
  const model = text || 'gemini-3.5-flash-lite';
  return model === mainModel ? null : model;
}

/**
 * Seconds for GEMINI_TIMEOUT_SECONDS. setTimeout holds at most 2^31-1 ms (about 24.8 days);
 * larger values (or Infinity) would fire at once, so they fall back to the default too.
 */
function readTimeoutSeconds(value, fallback) {
  const seconds = Number(value?.trim());
  return Number.isFinite(seconds) && seconds > 0 && seconds * 1000 <= 2_147_483_647 ? seconds : fallback;
}

/** A non-negative whole number from the environment (0 allowed), or the fallback. */
function readLimit(value, fallback) {
  const number = Number(value?.trim());
  return value?.trim() && Number.isInteger(number) && number >= 0 ? number : fallback;
}

const geminiModel = process.env.GEMINI_MODEL?.trim() || 'gemini-3.5-flash';

const config = {
  port: Number(process.env.PORT) || 3000,
  trustProxy: readTrustProxy(process.env.TRUST_PROXY),
  googleApiKey: process.env.GOOGLE_API_KEY?.trim() || '',
  geminiModel,
  geminiFallbackModel: readFallbackModel(process.env.GEMINI_FALLBACK_MODEL, geminiModel),
  // Seconds each model gets to answer (its own retries included) before the fallback is tried.
  geminiTimeoutSeconds: readTimeoutSeconds(process.env.GEMINI_TIMEOUT_SECONDS, 30),
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
  // Requests per visitor (IP). Generous for a demo, but one visitor can't use up the shared free quota. 0 = off.
  chatPerMinute: readLimit(process.env.RATE_LIMIT_CHAT_PER_MINUTE, 10),
  chatPerHour: readLimit(process.env.RATE_LIMIT_CHAT_PER_HOUR, 100),
  uploadsPerHour: readLimit(process.env.RATE_LIMIT_UPLOADS_PER_HOUR, 30),
  chunkSize: 1000,
  chunkOverlap: 150,
  topK: 4,
  maxHistoryMessages: 6,
};

export default config;
