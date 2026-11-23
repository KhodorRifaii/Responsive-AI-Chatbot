import { Router } from 'express';
import { answerQuestion, streamAnswer } from '../services/ragChain.js';
import config from '../config.js';
import { HttpError } from '../utils/httpError.js';
import { wantsNdjson, startNdjson, writeEvent, endWithError } from '../utils/ndjson.js';

const router = Router();

/**
 * Answer a question. With "Accept: application/x-ndjson" the answer streams as
 * { type: 'token', text } events and one final { type: 'done', answer, sources }. The stream
 * only starts with the first token, so every error before it (empty question, no documents,
 * expired session, missing key, all models failing) is a plain JSON error with its status.
 */
router.post('/', async (req, res, next) => {
  try {
    const question = String(req.body?.question ?? '').trim();
    const history = req.body?.history;
    if (req.sessionExpired) {
      throw new HttpError(410, 'SESSION_EXPIRED', `Your documents were removed after ${config.sessionTtlMinutes} minutes without activity (or a server restart). Upload them again to keep asking.`);
    }
    if (!wantsNdjson(req)) {
      return res.json(await answerQuestion({ question, history, session: req.docSession }));
    }

    const onToken = (text) => {
      if (!res.headersSent) startNdjson(res);
      writeEvent(res, { type: 'token', text });
    };
    const result = await streamAnswer({ question, history, session: req.docSession, onToken });
    // No token was sent (for example nothing was retrieved): a plain JSON answer is enough.
    if (!res.headersSent) return res.json(result);
    writeEvent(res, { type: 'done', ...result });
    res.end();
  } catch (error) {
    if (!res.headersSent) return next(error);
    if (!(error instanceof HttpError)) return endWithError(res, error);
    writeEvent(res, { type: 'error', status: error.status, code: error.code, error: error.message });
    res.end();
  }
});

export default router;
