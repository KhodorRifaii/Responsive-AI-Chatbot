import './env.js';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { RunnableLambda } from '@langchain/core/runnables';

let rag;
let session;
before(async () => {
  rag = await import('../src/services/ragChain.js');
  const store = await import('../src/services/vectorStore.js');
  session = store.createSession();
  const text = 'Warranty: every product has a warranty of 18 months.';
  await store.addDocument(session, { originalname: 'policy.txt', buffer: Buffer.from(text), size: text.length });
});

// Stand-ins for Gemini: one that answers, one that fails like the API, one that never answers.
const answers = (reply) => RunnableLambda.from(async () => reply);
const fails = (status, message) => RunnableLambda.from(async () => {
  throw Object.assign(new Error(message), { status });
});
const hangs = () => RunnableLambda.from(() => new Promise(() => {}));

const ask = (llm, fallbackLlm) => rag.answerQuestion({ question: 'How long is the warranty?', session, llm, fallbackLlm });

test('the fallback model answers when the main model is out of quota, busy or retired', async () => {
  for (const [status, message] of [[429, 'Resource exhausted: quota'], [503, 'The model is overloaded'], [404, 'models/x is not found']]) {
    const result = await ask(fails(status, message), answers('18 months.\nSOURCES: 1'));
    assert.equal(result.answer, '18 months.', `after a ${status}`);
  }
});

test('the fallback model answers when the main model times out', async () => {
  const result = await ask(hangs(), answers('18 months.\nSOURCES: 1'));
  assert.equal(result.answer, '18 months.');
});

test('no fallback for a bad request or a rejected key', async () => {
  let fallbackCalls = 0;
  const fallback = RunnableLambda.from(async () => {
    fallbackCalls += 1;
    return 'never used';
  });
  await assert.rejects(ask(fails(400, 'Invalid argument'), fallback), { code: 'LLM_ERROR' });
  await assert.rejects(ask(fails(403, 'API key not valid'), fallback), { code: 'LLM_AUTH' });
  assert.equal(fallbackCalls, 0);
});

test('when both models fail, the main model\'s error is reported', async () => {
  await assert.rejects(ask(fails(429, 'quota'), fails(503, 'overloaded')), { code: 'LLM_RATE_LIMIT' });
  await assert.rejects(ask(hangs(), hangs()), { code: 'LLM_TIMEOUT', status: 504 });
});

test('retryable errors are told apart from the others', () => {
  const error = (status, message = '') => Object.assign(new Error(message), { status });
  assert.equal(rag.isRetryableLlmError(error(500)), true);
  assert.equal(rag.isRetryableLlmError(new Error('fetch failed')), true);
  assert.equal(rag.isRetryableLlmError(new rag.LlmTimeoutError()), true);
  assert.equal(rag.isRetryableLlmError(error(404, 'models/gemini-x is not found for API version v1beta')), true);
  assert.equal(rag.isRetryableLlmError(error(404, 'Requested entity was not found')), false);
  assert.equal(rag.isRetryableLlmError(error(401)), false);
  assert.equal(rag.isRetryableLlmError(new Error('API key not valid')), false);
});
