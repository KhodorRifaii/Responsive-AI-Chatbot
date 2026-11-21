import multer from 'multer';
import config from '../config.js';
import { isSupportedFile } from '../services/documentLoader.js';
import { HttpError } from '../utils/httpError.js';

// Files are kept in memory only: parsed, embedded, then discarded.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxFileSizeMb * 1024 * 1024, files: 10 },
  fileFilter(req, file, cb) {
    // Multer decodes names as latin1; restore UTF-8 names (e.g. Arabic file names).
    file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
    if (!isSupportedFile(file.originalname)) {
      return cb(new HttpError(415, 'UNSUPPORTED_FILE', `"${file.originalname}" is not supported. Upload a PDF, DOCX, TXT or CSV file.`));
    }
    cb(null, true);
  },
});

export default upload;
