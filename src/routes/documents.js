import { Router } from 'express';
import upload from '../middleware/upload.js';
import { addDocument, listDocuments } from '../services/vectorStore.js';

const router = Router();

router.get('/', (req, res) => {
  res.json({ documents: listDocuments() });
});

router.post('/', upload.array('files', 10), async (req, res, next) => {
  try {
    const files = req.files ?? [];
    if (files.length === 0) {
      return res.status(400).json({ error: 'Choose at least one file to upload.' });
    }

    const added = [];
    for (const file of files) {
      added.push(await addDocument(file));
    }
    res.status(201).json({ documents: added });
  } catch (error) {
    next(error);
  }
});

export default router;
