import path from 'node:path';
import mammoth from 'mammoth';
import Papa from 'papaparse';
import { PDFParse } from 'pdf-parse';
import { Document } from '@langchain/core/documents';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import config from '../config.js';
import { HttpError } from '../utils/httpError.js';

export const SUPPORTED_EXTENSIONS = ['.pdf', '.docx', '.txt', '.csv'];

export function getExtension(fileName) {
  return path.extname(fileName).toLowerCase();
}

export function isSupportedFile(fileName) {
  return SUPPORTED_EXTENSIONS.includes(getExtension(fileName));
}

async function parsePdf(buffer) {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const result = await parser.getText();
    return result.pages.map((page) => ({ text: page.text, page: page.num }));
  } finally {
    await parser.destroy();
  }
}

async function parseDocx(buffer) {
  const { value } = await mammoth.extractRawText({ buffer });
  return [{ text: value }];
}

function parseTxt(buffer) {
  return [{ text: buffer.toString('utf8') }];
}

function parseCsv(buffer) {
  const { data, meta } = Papa.parse(buffer.toString('utf8'), {
    header: true,
    skipEmptyLines: 'greedy',
  });
  const fields = meta.fields ?? [];
  // One line per row ("column: value; ...") so each chunk keeps its column names.
  const lines = data.map((row, index) => {
    const cells = fields
      .filter((field) => String(row[field] ?? '').trim() !== '')
      .map((field) => `${field}: ${String(row[field]).trim()}`);
    return cells.length ? `Row ${index + 1}: ${cells.join('; ')}` : '';
  });
  return [{ text: lines.filter(Boolean).join('\n') }];
}

const parsers = {
  '.pdf': parsePdf,
  '.docx': parseDocx,
  '.txt': parseTxt,
  '.csv': parseCsv,
};

/**
 * Extract text from an uploaded file and split it into LangChain documents.
 * @param {{ originalname: string, buffer: Buffer }} file
 * @param {string} docId
 * @returns {Promise<Document[]>}
 */
export async function loadAndSplit(file, docId) {
  const extension = getExtension(file.originalname);
  const parse = parsers[extension];
  if (!parse) {
    throw new HttpError(415, 'UNSUPPORTED_FILE', `"${file.originalname}" is not supported. Upload a PDF, DOCX, TXT or CSV file.`);
  }
  if (!file.buffer?.length) {
    throw new HttpError(422, 'EMPTY_FILE', `"${file.originalname}" is empty.`);
  }

  let sections;
  try {
    sections = await parse(file.buffer);
  } catch (error) {
    console.error(`Failed to parse ${file.originalname}:`, error.message);
    throw new HttpError(422, 'PARSE_FAILED', `"${file.originalname}" could not be read. The file may be damaged or password-protected.`);
  }

  const pages = sections
    .map((section) => ({ ...section, text: section.text.replace(/\u0000/g, '').trim() }))
    .filter((section) => section.text.length > 0)
    .map((section) => new Document({
      pageContent: section.text,
      metadata: {
        docId,
        source: file.originalname,
        ...(section.page ? { page: section.page } : {}),
      },
    }));

  if (pages.length === 0) {
    const hint = extension === '.pdf' ? ' Scanned PDFs (images only) are not supported.' : '';
    throw new HttpError(422, 'EMPTY_FILE', `"${file.originalname}" has no readable text.${hint}`);
  }

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: config.chunkSize,
    chunkOverlap: config.chunkOverlap,
  });
  const chunks = await splitter.splitDocuments(pages);
  return chunks.map((chunk, index) => {
    chunk.metadata = { ...chunk.metadata, chunk: index + 1 };
    delete chunk.metadata.loc;
    return chunk;
  });
}
