import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAndSplit, isSupportedFile } from '../src/services/documentLoader.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name) => ({ originalname: name, buffer: fs.readFileSync(path.join(fixtures, name)) });
const textFile = (name, text, encoding = 'utf8') => ({ originalname: name, buffer: Buffer.from(text, encoding) });

async function rejectsWith(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

test('PDF: one chunk per page, with the page number', async () => {
  const chunks = await loadAndSplit(fixture('sample.pdf'), 'doc1');
  assert.deepEqual(chunks.map((c) => c.metadata.page), [1, 2]);
  assert.match(chunks[1].pageContent, /Parking costs 5 dollars/);
  assert.equal(chunks[0].metadata.source, 'sample.pdf');
  assert.equal(chunks[0].metadata.docId, 'doc1');
});

test('DOCX: text of every paragraph, no page number', async () => {
  const [chunk] = await loadAndSplit(fixture('sample.docx'), 'doc2');
  assert.match(chunk.pageContent, /Remote work is allowed two days per week/);
  assert.match(chunk.pageContent, /Laptops are replaced every three years/);
  assert.equal(chunk.metadata.page, undefined);
});

test('TXT: text kept and chunks numbered from 1', async () => {
  const chunks = await loadAndSplit(textFile('notes.txt', 'Hello world.'), 'd');
  assert.equal(chunks[0].pageContent, 'Hello world.');
  assert.equal(chunks[0].metadata.chunk, 1);
});

test('TXT: long text is split into overlapping chunks of at most 1000 characters', async () => {
  const text = Array.from({ length: 300 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
  const chunks = await loadAndSplit(textFile('long.txt', text), 'd');
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.pageContent.length <= 1000));
  assert.deepEqual(chunks.map((c) => c.metadata.chunk), chunks.map((_, i) => i + 1));
});

test('TXT: UTF-16 files with a byte order mark are decoded', async () => {
  const buffer = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Café hours', 'utf16le')]);
  const [chunk] = await loadAndSplit({ originalname: 'win.txt', buffer }, 'd');
  assert.equal(chunk.pageContent, 'Café hours');
});

test('CSV: each row becomes "Row n: column: value" so chunks keep column names', async () => {
  const [chunk] = await loadAndSplit(textFile('prices.csv', 'item,price\nTea,3\nCoffee,\n\n'), 'd');
  assert.equal(chunk.pageContent, 'Row 1: item: Tea; price: 3\nRow 2: item: Coffee');
});

test('unsupported, empty and unreadable files get clear errors', async () => {
  assert.equal(isSupportedFile('Report.PDF'), true);
  assert.equal(isSupportedFile('photo.png'), false);
  await rejectsWith(loadAndSplit(textFile('photo.png', 'x'), 'd'), 'UNSUPPORTED_FILE');
  await rejectsWith(loadAndSplit(textFile('empty.txt', ''), 'd'), 'EMPTY_FILE');
  await rejectsWith(loadAndSplit(textFile('blank.txt', '   \n  '), 'd'), 'EMPTY_FILE');
  await rejectsWith(loadAndSplit(textFile('fake.pdf', 'not a pdf'), 'd'), 'PARSE_FAILED');
});

test('only an empty PDF mentions scanned PDFs', async () => {
  await assert.rejects(loadAndSplit(textFile('blank.txt', ' '), 'd'), (e) => !/Scanned/.test(e.message));
});
