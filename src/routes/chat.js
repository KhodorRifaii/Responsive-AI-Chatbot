import { Router } from 'express';
import { answerQuestion } from '../services/ragChain.js';

const router = Router();

router.post('/', async (req, res, next) => {
  try {
    const question = String(req.body?.question ?? '').trim();
    const history = req.body?.history;
    const result = await answerQuestion({ question, history });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

export default router;
