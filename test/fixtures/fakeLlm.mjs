// A scripted stand-in for Gemini, loaded by `EVAL_FAKE_LLM=<this file> node eval/run.js` (see test/evalRun.test.js).
// FAKE_LLM_MODE: "ok" answers every question; "main-503" makes the main model fail with 503 and has no fallback;
// "fallback" makes the main model fail with 429 so the (fake) fallback model answers.
import { RunnableLambda } from '@langchain/core/runnables';

const answers = (model) => Object.assign(RunnableLambda.from(async () => 'Fake answer.\nSOURCES: none'), { model });
const fails = (status, message, model) => Object.assign(RunnableLambda.from(async () => {
  throw Object.assign(new Error(message), { status });
}), { model });

const mode = process.env.FAKE_LLM_MODE ?? 'ok';
export default mode === 'main-503'
  ? { llm: fails(503, 'The model is overloaded', 'gemini-3.5-flash-lite') }
  : mode === 'fallback'
    ? { llm: fails(429, 'quota exceeded', 'gemini-3.5-flash-lite'), fallbackLlm: answers('gemini-3.1-flash-lite') }
    : { llm: answers('gemini-3.5-flash-lite') };
