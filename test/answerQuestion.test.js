import './env.js';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { FakeListChatModel } from '@langchain/core/utils/testing';

let rag;
let store;
let session;
before(async () => {
  rag = await import('../src/services/ragChain.js');
  store = await import('../src/services/vectorStore.js');
  session = store.createSession();
  const text = 'Warranty: every product has a warranty of 18 months.\n\nParking costs 5 dollars per day.';
  await store.addDocument(session, { originalname: 'policy.txt', buffer: Buffer.from(text), size: text.length });
});

const fakeLlm = (reply) => new FakeListChatModel({ responses: [reply] });

async function rejectsWith(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

test('answers with the cited excerpt as the source, without the SOURCES line', async () => {
  const result = await rag.answerQuestion({ question: 'How long is the warranty?', session, llm: fakeLlm('18 months.\nSOURCES: 1') });
  assert.equal(result.answer, '18 months.');
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].source, 'policy.txt');
  assert.match(result.sources[0].excerpt, /18 months/);
});

test('"not found" answers show no sources', async () => {
  const result = await rag.answerQuestion({ question: 'Who is the CEO?', session, llm: fakeLlm(`${rag.NOT_FOUND_ANSWER}\nSOURCES: none`) });
  assert.equal(result.answer, rag.NOT_FOUND_ANSWER);
  assert.deepEqual(result.sources, []);
});

test('empty, too long and no-document questions are refused before calling the AI', async () => {
  await rejectsWith(rag.answerQuestion({ question: '', session }), 'EMPTY_QUESTION');
  await rejectsWith(rag.answerQuestion({ question: 'x'.repeat(2001), session }), 'QUESTION_TOO_LONG');
  await rejectsWith(rag.answerQuestion({ question: 'Hi?', session: null }), 'NO_DOCUMENTS');
});

test('without an API key the error says how to add one', async () => {
  await rejectsWith(rag.answerQuestion({ question: 'Warranty?', session }), 'MISSING_API_KEY');
});
