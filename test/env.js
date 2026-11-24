// Fixed settings for every test, so a developer's own .env or shell can't change the results.
// Import this file FIRST in each test file: ES module imports run in order, so these values
// are set before the app's config (and dotenv, which never overrides them) is loaded.
Object.assign(process.env, {
  GOOGLE_API_KEY: '',
  GEMINI_MODEL: 'gemini-3.5-flash',
  GEMINI_FALLBACK_MODEL: 'gemini-3.5-flash-lite',
  // Short, so the timeout test is quick. Fake models answer instantly.
  GEMINI_TIMEOUT_SECONDS: '0.2',
  GEMINI_THINKING_BUDGET: '0',
  GEMINI_THINKING_LEVEL: 'minimal',
  EMBEDDING_MODEL: 'Xenova/all-MiniLM-L6-v2',
  EMBEDDING_DTYPE: 'q8',
  EMBEDDING_THREADS: '1',
  // The default model's own profile: nothing from a developer's .env can change it.
  EMBEDDING_POOLING: '',
  EMBEDDING_QUERY_PREFIX: '',
  EMBEDDING_DOCUMENT_PREFIX: '',
  EMBEDDING_DIMENSIONS: '',
  MAX_FILE_SIZE_MB: '10',
  SESSION_TTL_MINUTES: '30',
  MAX_SESSIONS: '100',
  MAX_CHUNKS_PER_SESSION: '1500',
  MAX_TOTAL_CHUNKS: '5000',
  RATE_LIMIT_CHAT_PER_MINUTE: '3',
  RATE_LIMIT_CHAT_PER_HOUR: '100',
  RATE_LIMIT_UPLOADS_PER_HOUR: '3',
});
