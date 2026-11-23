import { Router } from 'express';
import { answerQuestion } from '../services/ragChain.js';
import config from '../config.js';
import { HttpError } from '../utils/httpError.js';

const router = Router();

router.post('/', async (req, res, next) => {
  try {
    const question = String(req.body?.question ?? '').trim();
    const history = req.body?.history;
    if (req.sessionExpired) {
      throw new HttpError(410, 'SESSION_EXPIRED', `Your documents were removed after ${config.sessionTtlMinutes} minutes without activity (or a server restart). Upload them again to keep asking.`);
    }
    const result = await answerQuestion({ question, history, session: req.docSession });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

export default router;
