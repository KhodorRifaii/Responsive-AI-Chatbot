import './env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitCitations } from '../src/services/ragChain.js';

test('reads the SOURCES line and removes it from the answer', () => {
  assert.deepEqual(splitCitations('The warranty is 18 months.\nSOURCES: 1, 3'), { answer: 'The warranty is 18 months.', cited: [1, 3] });
});

test('accepts bold, missing colon and extra spaces', () => {
  assert.deepEqual(splitCitations('Answer.\n**SOURCES:** 2').cited, [2]);
  assert.deepEqual(splitCitations('Answer.\nSources 4 ,5  ').cited, [4, 5]);
});

test('"SOURCES: none" means no citations', () => {
  assert.deepEqual(splitCitations("I couldn't find that.\nSOURCES: none"), { answer: "I couldn't find that.", cited: [] });
});

test('no SOURCES line returns cited null, and the answer stays whole', () => {
  assert.deepEqual(splitCitations('Just an answer.'), { answer: 'Just an answer.', cited: null });
});

test('only the last line counts, not the word "sources" in the text', () => {
  const { answer, cited } = splitCitations('Our sources: 2 suppliers deliver daily.\nSOURCES: 1');
  assert.equal(answer, 'Our sources: 2 suppliers deliver daily.');
  assert.deepEqual(cited, [1]);
});

test('a SOURCES list may end the last sentence, but ordinary text about sources stays', () => {
  assert.deepEqual(splitCitations('18 months. SOURCES: 1, 2'), { answer: '18 months.', cited: [1, 2] });
  assert.deepEqual(splitCitations('The sources are described in the appendix.'), { answer: 'The sources are described in the appendix.', cited: null });
  assert.deepEqual(splitCitations('Sources of income: salary.').cited, null);
});

test('citation lists with brackets, "and" or ranges are read too', () => {
  assert.deepEqual(splitCitations('The warranty is 18 months.\nSOURCES: [1], [3]'), { answer: 'The warranty is 18 months.', cited: [1, 3] });
  assert.deepEqual(splitCitations('18 months.\nSOURCES: 1 and 3').cited, [1, 3]);
  assert.deepEqual(splitCitations('18 months. SOURCES: 1-3').cited, [1, 3]);
  assert.equal(splitCitations('Our sources: 2 and more suppliers.').cited, null);
});
