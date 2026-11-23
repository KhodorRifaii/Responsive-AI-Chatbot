import { Router } from 'express';
import upload from '../middleware/upload.js';
import { addDocument, listDocuments } from '../services/vectorStore.js';
import { HttpError } from '../utils/httpError.js';
import { wantsNdjson, startNdjson, writeEvent, endWithError } from '../utils/ndjson.js';

const router = Router();

router.get('/', (req, res) => {
  res.json({ documents: listDocuments(req.docSession), sessionExpired: req.sessionExpired });
});

/**
 * Upload files. With "Accept: application/x-ndjson" the answer is a stream of
 * { type: 'progress', file, files, name, stage, done, total } events and one final
 * { type: 'result', status, ...same body as the JSON answer }. Errors that happen before
 * any file is processed (limits, file type, no files, server busy) are plain JSON either way.
 */
router.post('/', upload.array('files', 10), async (req, res, next) => {
  const stream = wantsNdjson(req);
  try {
    const files = req.files ?? [];
    if (files.length === 0) {
      return res.status(400).json({ error: 'Choose at least one file to upload.' });
    }

    // Creates the session cookie, so it must run before the stream sends the headers.
    const session = req.ensureDocSession();
    if (stream) startNdjson(res);
    const added = [];
    const errors = [];
    for (const [index, file] of files.entries()) {
      const onProgress = stream
        ? (progress) => writeEvent(res, { type: 'progress', file: index + 1, files: files.length, name: file.originalname, ...progress })
        : undefined;
      try {
        added.push(await addDocument(session, file, { onProgress }));
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        errors.push({ name: file.originalname, error: error.message, code: error.code });
        // The session expired during this upload: its documents are gone, so stop here.
        if (error.code === 'SESSION_EXPIRED') break;
      }
    }

    // sessionExpired: the visitor's earlier documents were gone, so the page clears its old chat.
    const sessionExpired = req.sessionExpired || errors.some((e) => e.code === 'SESSION_EXPIRED');
    const [status, body] = added.length === 0
      ? [422, { error: errors.map((e) => e.error).join(' '), code: errors[0].code, errors, sessionExpired }]
      : [201, { documents: added, errors, sessionExpired }];
    if (!stream) return res.status(status).json(body);
    writeEvent(res, { type: 'result', status, ...body });
    res.end();
  } catch (error) {
    if (res.headersSent) return endWithError(res, error);
    next(error);
  }
});

export default router;
