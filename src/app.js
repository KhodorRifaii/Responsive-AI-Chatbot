import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from './config.js';
import documentsRouter from './routes/documents.js';

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

// Central error handler: always answer with a JSON { error } message.
app.use((error, req, res, next) => {
  const status = error.status || 500;
  if (status >= 500) console.error(error);
  res.status(status).json({
    error: status >= 500 ? 'Something went wrong on the server. Please try again.' : error.message,
    code: error.code,
  });
});

export default app;
