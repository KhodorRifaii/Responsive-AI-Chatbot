import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from './config.js';
import { HttpError } from './utils/httpError.js';
import documentsRouter from './routes/documents.js';
import chatRouter from './routes/chat.js';
import { sessionMiddleware } from './middleware/session.js';
import { createRateLimiter } from './middleware/rateLimit.js';
import { securityHeaders } from './middleware/securityHeaders.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

// Render sits behind one proxy; this makes req.ip (rate limits) and req.secure (Secure cookies)
// use the real visitor. Set TRUST_PROXY=false when nothing sits in front of the app.
app.set('trust proxy', config.trustProxy);
app.disable('x-powered-by');
app.use(securityHeaders);

app.use(express.json({ limit: '1mb' }));
// Vendor files have the version in their path (vendor/bootstrap/5.3.3/…), so browsers may keep them a year.
app.use('/vendor', express.static(path.join(__dirname, '..', 'public', 'vendor'), { maxAge: '1y', immutable: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    llmConfigured: Boolean(config.googleApiKey),
    model: config.geminiModel,
    fallbackModel: config.geminiFallbackModel,
    // 'google' = the text of uploaded documents is sent to Google for embedding, so the page shows a notice.
    embeddingProvider: config.embeddingProvider,
  });
});

// Per-visitor limits on the expensive calls (Gemini answers, embedding uploads).
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
export const limiters = {
  chatMinute: createRateLimiter({ max: config.chatPerMinute, windowMs: MINUTE, action: 'questions' }),
  chatHour: createRateLimiter({ max: config.chatPerHour, windowMs: HOUR, action: 'questions' }),
  uploads: createRateLimiter({ max: config.uploadsPerHour, windowMs: HOUR, action: 'uploads' }),
};
app.post('/api/chat', limiters.chatMinute, limiters.chatHour);
app.post('/api/documents', limiters.uploads);

app.use('/api', sessionMiddleware);
app.use('/api/documents', documentsRouter);
app.use('/api/chat', chatRouter);

// Unknown API routes answer in JSON like every other API error.
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'This API route does not exist.', code: 'NOT_FOUND' });
});

// Central error handler: always answer with a JSON { error } message.
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    const messages = {
      LIMIT_FILE_SIZE: `A file is too large. The limit is ${config.maxFileSizeMb} MB per file.`,
      LIMIT_FILE_COUNT: 'Upload up to 10 files at a time.',
      LIMIT_UNEXPECTED_FILE: 'Unexpected upload field. Use the upload button.',
    };
    return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400)
      .json({ error: messages[error.code] || 'The upload failed. Please try again.', code: error.code });
  }
  if (error.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'The request was not valid JSON.', code: 'BAD_JSON' });
  }

  // Known errors (HttpError) carry a message written for the user; anything else stays generic.
  const known = error instanceof HttpError;
  const status = error.status || 500;
  if (!known && status >= 500) console.error(error);
  res.status(status).json({
    error: known || status < 500 ? error.message : 'Something went wrong on the server. Please try again.',
    code: error.code,
  });
});

export default app;
