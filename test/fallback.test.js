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
// Models report their name in logs and errors (the real ChatGoogleGenerativeAI has `model`).
const named = (llm, model) => Object.assign(llm, { model });

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

test('no fallback for a bad request or a rejected key', async (t) => {
  let fallbackCalls = 0;
  const fallback = RunnableLambda.from(async () => {
    fallbackCalls += 1;
    return 'never used';
  });
  t.mock.method(console, 'error', () => {});
  await assert.rejects(ask(fails(400, 'Request contains an invalid argument.'), fallback), { code: 'LLM_CONFIG' });
  await assert.rejects(ask(fails(403, 'API key not valid'), fallback), { code: 'LLM_AUTH' });
  assert.equal(fallbackCalls, 0);
});

test('a 400 from the main model names the model and its setting, and is not hidden by the fallback', async (t) => {
  t.mock.method(console, 'error', () => {});
  await assert.rejects(ask(named(fails(400, 'Request contains an invalid argument.'), 'gemini-x'), answers('never used')), (error) => {
    assert.equal(error.code, 'LLM_CONFIG');
    assert.match(error.message, /"gemini-x"/);
    assert.match(error.message, /GEMINI_MODEL/);
    assert.match(error.message, /GEMINI_THINKING_LEVEL/);
    return true;
  });
});

test('a 400 from the fallback model is logged with a config hint and reported as a config error, also after a transient main failure', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  // The provider's real message for a thinking setting the model rejects has no "thinking" in it.
  const bad = () => named(fails(400, 'Request contains an invalid argument.'), 'gemini-fallback');
  for (const main of [fails(503, 'overloaded'), fails(429, 'quota exceeded'), hangs()]) {
    warn.mock.resetCalls();
    await assert.rejects(ask(main, bad()), (error) => {
      assert.equal(error.code, 'LLM_CONFIG');
      assert.match(error.message, /"gemini-fallback"/);
      assert.match(error.message, /GEMINI_FALLBACK_MODEL/);
      return true;
    });
    assert.ok(warn.mock.calls.some((call) => /fallback model gemini-fallback failed too \(400 Request contains an invalid argument\..*config error.*GEMINI_THINKING_LEVEL/.test(call.arguments[0])));
  }
});

test('the fallback model\'s own failure is logged', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  await assert.rejects(ask(fails(503, 'overloaded'), fails(500, 'Internal error')), { code: 'LLM_BUSY' });
  assert.ok(warn.mock.calls.some((call) => /fallback model .* failed too \(500 Internal error/.test(call.arguments[0])));
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
