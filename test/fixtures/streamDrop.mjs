// Run by test/streamCrash.test.js in its own process (node:test treats every unhandled rejection
// as a failure, so the app's own guard can only be checked outside the test runner).
// A fake Gemini API streams one piece of text, then the connection drops (undici's "terminated").
import '../env.js';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';

const realFetch = globalThis.fetch;
const encoder = new TextEncoder();
globalThis.fetch = async (url, options) => {
  if (!String(url).includes('generativelanguage.googleapis.com')) return realFetch(url, options);
  let sent = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (sent++ > 0) return controller.error(new TypeError('terminated'));
      const piece = { candidates: [{ content: { parts: [{ text: '18 months' }], role: 'model' }, index: 0 }] };
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(piece)}\r\n\r\n`));
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
};

const rag = await import('../../src/services/ragChain.js');
const store = await import('../../src/services/vectorStore.js');
const session = store.createSession();
const text = 'Warranty: every product has a warranty of 18 months.';
await store.addDocument(session, { originalname: 'policy.txt', buffer: Buffer.from(text), size: text.length });

const tokens = [];
let code = null;
try {
  const llm = new ChatGoogleGenerativeAI({ model: 'fake-model', apiKey: 'test', maxRetries: 0 });
  await rag.streamAnswer({ question: 'How long is the warranty?', session, llm, onToken: (t) => tokens.push(t) });
} catch (error) {
  code = error.code;
}
// Give the SDK's unawaited `response` promise time to reject; without the guard Node exits here.
await new Promise((resolve) => setTimeout(resolve, 200));
console.log(JSON.stringify({ code, tokens: tokens.join(''), alive: true }));
