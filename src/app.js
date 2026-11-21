import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from './config.js';
import { HttpError } from './utils/httpError.js';
import documentsRouter from './routes/documents.js';
import chatRouter from './routes/chat.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    llmConfigured: Boolean(config.googleApiKey),
    model: config.geminiModel,
  });
});

app.use('/api/documents', documentsRouter);
app.use('/api/chat', chatRouter);

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
