// The text of every chunk of the eval documents, split by the app's own loader, so retrieved chunks
// (stored as source + chunk number) can be checked for the gold facts. The split is deterministic.
import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {string} docsDir folder with the eval documents
 * @param {(file: { originalname: string, buffer: Buffer }, id: string) => Promise<Array<{ pageContent: string, metadata: { chunk: number } }>>} loadAndSplit the app's loader
 * @returns {Promise<(source: string, chunk: number) => string | undefined>}
 */
export async function loadChunkTexts(docsDir, loadAndSplit) {
  const texts = new Map();
  for (const name of fs.readdirSync(docsDir).filter((f) => !f.startsWith('.')).sort()) {
    const buffer = fs.readFileSync(path.join(docsDir, name));
    for (const chunk of await loadAndSplit({ originalname: name, buffer }, name)) texts.set(`${name}#${chunk.metadata.chunk}`, chunk.pageContent);
  }
  return (source, chunk) => texts.get(`${source}#${chunk}`);
}
