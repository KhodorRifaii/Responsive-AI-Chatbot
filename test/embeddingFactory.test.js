// EMBEDDING_PROVIDER picks the embedder, and with `google` the local model code is not even loaded (no native onnxruntime, so no memory for it).
import './env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Imports the vector store in a fresh process with the given environment; reports the embedder class and whether onnxruntime is loaded. */
function boot(env) {
  const code = `
    const store = await import('./src/services/vectorStore.js');
    const { default: config } = await import('./src/config.js');
    const onnx = process.report.getReport().sharedObjects.some((file) => /onnxruntime/i.test(file));
    console.log(JSON.stringify({ embedder: store.embeddings.constructor.name, model: config.embeddingModel, provider: config.embeddingProvider, onnx }));
    process.exit(0);`;
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(EMBEDDING_|GOOGLE_API_KEY)/.test(key)));
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: root, env: { ...clean, DOTENV_CONFIG_PATH: os.devNull, ...env }, encoding: 'utf8', timeout: 60000 });
  const line = result.stdout.trim().split('\n').pop();
  return { result: JSON.parse(line), stderr: result.stderr };
}

test('default provider: the local embedder, with MiniLM, and its native runtime is loaded', () => {
  const { result } = boot({});
  assert.deepEqual(result, { embedder: 'LocalEmbeddings', model: 'Xenova/all-MiniLM-L6-v2', provider: 'local', onnx: true });
});

test('EMBEDDING_PROVIDER=google: the Google embedder, gemini-embedding-2 by default, and the local model code is never loaded', () => {
  const { result } = boot({ EMBEDDING_PROVIDER: 'google', GOOGLE_API_KEY: 'AIzaSyTESTTESTTESTTESTTESTTESTTESTTEST1' });
  assert.deepEqual(result, { embedder: 'GoogleEmbeddings', model: 'gemini-embedding-2', provider: 'google', onnx: false });
});

test('an unknown provider falls back to local with a warning (the side that sends no text to anyone)', () => {
  const { result, stderr } = boot({ EMBEDDING_PROVIDER: 'openai' });
  assert.equal(result.embedder, 'LocalEmbeddings');
  assert.match(stderr, /EMBEDDING_PROVIDER=openai ignored/);
});

test('google without a key warns at startup (uploads fail with MISSING_API_KEY until it is set)', () => {
  const { stderr } = boot({ EMBEDDING_PROVIDER: 'google' });
  assert.match(stderr, /EMBEDDING_PROVIDER=google needs GOOGLE_API_KEY/);
});
