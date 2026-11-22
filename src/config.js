import 'dotenv/config';

const config = {
  port: Number(process.env.PORT) || 3000,
  googleApiKey: process.env.GOOGLE_API_KEY?.trim() || '',
  geminiModel: process.env.GEMINI_MODEL?.trim() || 'gemini-3.5-flash',
  embeddingModel: process.env.EMBEDDING_MODEL?.trim() || 'Xenova/all-MiniLM-L6-v2',
  // q8 (quantized) and 1 thread keep memory low enough for 512 MB hosts.
  embeddingDtype: process.env.EMBEDDING_DTYPE?.trim() || 'q8',
  embeddingThreads: Number(process.env.EMBEDDING_THREADS) || 1,
  maxFileSizeMb: Number(process.env.MAX_FILE_SIZE_MB) || 10,
  chunkSize: 1000,
  chunkOverlap: 150,
  topK: 4,
  maxHistoryMessages: 6,
};

export default config;
