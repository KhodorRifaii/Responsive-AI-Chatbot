import path from 'node:path';
import { Document } from '@langchain/core/documents';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import config from '../config.js';

export const SUPPORTED_EXTENSIONS = ['.txt'];

export function getExtension(fileName) {
  return path.extname(fileName).toLowerCase();
}

export function isSupportedFile(fileName) {
  return SUPPORTED_EXTENSIONS.includes(getExtension(fileName));
}

function parseTxt(buffer) {
  return [{ text: buffer.toString('utf8') }];
}

const parsers = {
  '.txt': parseTxt,
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
  const sections = await parse(file.buffer);

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
