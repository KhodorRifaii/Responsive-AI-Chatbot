import 'dotenv/config';

const config = {
  port: Number(process.env.PORT) || 3000,
  googleApiKey: process.env.GOOGLE_API_KEY?.trim() || '',
  geminiModel: process.env.GEMINI_MODEL?.trim() || 'gemini-2.5-flash',
  embeddingModel: process.env.EMBEDDING_MODEL?.trim() || 'Xenova/all-MiniLM-L6-v2',
  maxFileSizeMb: Number(process.env.MAX_FILE_SIZE_MB) || 10,
  chunkSize: 1000,
  chunkOverlap: 150,
  topK: 4,
  maxHistoryMessages: 6,
};

export default config;
