// The privacy notice of the hosted embedder: the page learns the provider from /api/health, the notice element is in the page and
// hidden by default. Hermetic: no key, no network; the google case runs the app in a child process with a fake key.
import './env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const NOTICE = 'Your documents are processed by Google to answer questions.';

/** Boots the app in a fresh process with the given environment and returns the answer of GET /api/health (as parsed JSON). */
function health(env) {
  const code = `
    const { default: app } = await import('./src/app.js');
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/health');
    console.log(JSON.stringify(await response.json()));
    process.exit(0);`;
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(EMBEDDING_|GOOGLE_API_KEY)/.test(key)));
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: root, env: { ...clean, DOTENV_CONFIG_PATH: os.devNull, ...env }, encoding: 'utf8', timeout: 60000 });
  return JSON.parse(result.stdout.trim().split('\n').pop());
}

test('/api/health tells the page the embedding provider: local by default', () => {
  const body = health({});
  assert.equal(body.embeddingProvider, 'local');
  assert.deepEqual(Object.keys(body).sort(), ['embeddingProvider', 'fallbackModel', 'llmConfigured', 'model', 'status'], 'one new field, nothing else (no key, no embedding model)');
});

test('/api/health says google when EMBEDDING_PROVIDER=google, and still exposes no key or secret', () => {
  const body = health({ EMBEDDING_PROVIDER: 'google', GOOGLE_API_KEY: 'AIzaSyTESTTESTTESTTESTTESTTESTTESTTEST1' });
  assert.equal(body.embeddingProvider, 'google');
  assert.equal(body.llmConfigured, true);
  assert.doesNotMatch(JSON.stringify(body), /AIza/);
  assert.deepEqual(Object.keys(body).sort(), ['embeddingProvider', 'fallbackModel', 'llmConfigured', 'model', 'status']);
});

test('an unknown provider value is reported as what is really used: local', () => {
  assert.equal(health({ EMBEDDING_PROVIDER: 'gogle' }).embeddingProvider, 'local');
});

test('the page has the notice in the upload area: a real text element, hidden by default, icon hidden from screen readers', () => {
  const html = read('public/index.html');
  const notice = html.match(/<p\b[^>]*\bid="providerNotice"[^>]*>[\s\S]*?<\/p>/)?.[0];
  assert.ok(notice, 'element #providerNotice exists');
  assert.match(notice, /\bhidden\b/, 'hidden until the page knows the provider is google');
  assert.ok(notice.includes(NOTICE), 'the exact sentence, as text in the page (not a tooltip)');
  assert.match(notice, /<i class="bi bi-info-circle" aria-hidden="true"><\/i>/);
  const upload = html.match(/<section aria-labelledby="uploadTitle">[\s\S]*?<\/section>/)[0];
  assert.ok(upload.includes('id="providerNotice"'), 'it sits inside the "Add documents" section');
  assert.equal((html.match(/id="providerNotice"/g) ?? []).length, 1);
});

test('small screens (sidebar closed) get the same notice above the composer: same text, hidden by default, no aria-describedby (which would read it out even when hidden)', () => {
  const html = read('public/index.html');
  const notice = html.match(/<p\b[^>]*\bid="providerNoticeChat"[^>]*>[\s\S]*?<\/p>/)?.[0];
  assert.ok(notice, 'element #providerNoticeChat exists');
  assert.match(notice, /\bhidden\b/);
  assert.match(notice, /\bd-lg-none\b/, 'only where the sidebar is closed');
  assert.ok(notice.includes(NOTICE));
  assert.doesNotMatch(html, /aria-describedby="providerNotice/);
  assert.match(read('public/js/app.js'), /providerNoticeChat\.hidden = embeddingProvider !== 'google'/);
});

test('the script shows it only for google, and the stylesheet keeps [hidden] working on the notice', () => {
  assert.match(read('public/js/app.js'), /providerNotice\.hidden = embeddingProvider !== 'google'/);
  assert.match(read('public/css/styles.css'), /\.upload-notice\[hidden\]\s*\{\s*display:\s*none;?\s*\}/);
});
