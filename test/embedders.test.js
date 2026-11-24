// Which candidates eval/embedders.js runs, and with which environment. Pure: nothing is run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { CANDIDATES, PAID_QUOTA_CANDIDATES, ALL, only, envFor } from '../eval/embedders.js';

test('a plain run covers the free local candidates only: hosted models spend API quota and must be named', () => {
  const labels = only(['node', 'embedders.js']).map((c) => c.label);
  assert.deepEqual(labels, CANDIDATES.map((c) => c.label));
  assert.ok(labels.every((label) => !label.startsWith('google')));
  assert.ok(PAID_QUOTA_CANDIDATES.every((c) => c.provider === 'google'));
  assert.ok(CANDIDATES.every((c) => !c.provider || c.provider === 'local'));
});

test('--only runs exactly the named candidates, hosted ones included; an unknown label is an error', () => {
  assert.deepEqual(only(['x', 'y', '--only', 'google-embedding-2']).map((c) => c.label), ['google-embedding-2']);
  assert.deepEqual(only(['x', 'y', '--only', 'e5-small,google-embedding-001']).map((c) => c.label), ['e5-small', 'google-embedding-001']);
  assert.throws(() => only(['x', 'y', '--only', 'google-embedding-3']), /unknown candidate google-embedding-3/);
  assert.equal(new Set(ALL.map((c) => c.label)).size, ALL.length, 'labels are unique');
});

test('a hosted candidate reads the project .env for the key but pins every EMBEDDING_* setting (prefixes to the model own), so the file cannot change its profile', () => {
  const saved = { ...process.env };
  Object.assign(process.env, { EMBEDDING_DIMENSIONS: '99', EMBEDDING_QUERY_PREFIX: 'x', EMBEDDING_PROVIDER: 'local' });
  try {
    const env = envFor({ model: 'gemini-embedding-2', provider: 'google' });
    assert.equal(env.EMBEDDING_PROVIDER, 'google');
    assert.equal(env.EMBEDDING_MODEL, 'gemini-embedding-2');
    assert.equal(env.EMBEDDING_DIMENSIONS, '');
    // An empty prefix would mean "no prefix", so the prefixes are pinned to the model's own (gemini-embedding-2 asks for them).
    assert.equal(env.EMBEDDING_QUERY_PREFIX, 'task: search result | query: ');
    assert.equal(env.EMBEDDING_DOCUMENT_PREFIX, 'title: none | text: ');
    assert.equal(envFor({ model: 'gemini-embedding-001', provider: 'google' }).EMBEDDING_QUERY_PREFIX, '');
    assert.equal(path.basename(env.DOTENV_CONFIG_PATH), '.env');
    // A local candidate never reads .env.
    const local = envFor({ model: 'Xenova/all-MiniLM-L6-v2', dtype: 'q8' });
    assert.equal(local.DOTENV_CONFIG_PATH, '/dev/null');
    assert.equal(local.EMBEDDING_PROVIDER, undefined);
  } finally {
    for (const key of ['EMBEDDING_DIMENSIONS', 'EMBEDDING_QUERY_PREFIX', 'EMBEDDING_PROVIDER']) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});
