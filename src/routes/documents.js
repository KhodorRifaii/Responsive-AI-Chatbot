import { Router } from 'express';
import upload from '../middleware/upload.js';
import { addDocument, listDocuments } from '../services/vectorStore.js';
import { HttpError } from '../utils/httpError.js';

const router = Router();

router.get('/', (req, res) => {
  res.json({ documents: listDocuments(req.docSession) });
});

router.post('/', upload.array('files', 10), async (req, res, next) => {
  try {
    const files = req.files ?? [];
    if (files.length === 0) {
      return res.status(400).json({ error: 'Choose at least one file to upload.' });
    }

    const session = req.ensureDocSession();
    const added = [];
    const errors = [];
    for (const file of files) {
      try {
        added.push(await addDocument(session, file));
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        errors.push({ name: file.originalname, error: error.message, code: error.code });
      }
    }

    if (added.length === 0) {
      const [first] = errors;
      return res.status(422).json({ error: errors.map((e) => e.error).join(' '), code: first.code, errors });
    }
    res.status(201).json({ documents: added, errors });
  } catch (error) {
    next(error);
  }
});

export default router;
