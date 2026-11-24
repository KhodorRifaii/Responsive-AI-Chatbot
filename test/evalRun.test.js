// Offline test of `node eval/run.js --retrieval-only`: it loads the eval documents with the local embedding
// model (downloaded once, like the other tests) and never calls Gemini.
import './env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const runner = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'eval', 'run.js');
const run = (args, cwd) => spawnSync(process.execPath, [runner, ...args], { cwd, encoding: 'utf8', env: process.env, timeout: 120_000 });

test('retrieval-only run: 23 of 25 answerable questions find every expected file in the top 4, with no answer scores', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-run-'));
  try {
    // A paid full-run file already sits at the target: it must be archived, not overwritten.
    const full = { meta: { mode: 'full', date: '2026-01-02T03:04:05.000Z' }, results: [] };
    fs.writeFileSync(path.join(dir, 'out.json'), JSON.stringify(full));
    // A relative --out is resolved from the folder the command was run in (dir), not from the project.
    const result = run(['--retrieval-only', '--out', 'out.json'], dir);
    assert.equal(result.status, 0, result.stderr);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'out.json'), 'utf8'));
    assert.equal(saved.meta.mode, 'retrieval-only');
    const answerable = saved.results.filter((r) => r.score.answerable);
    // Expected from the committed documents and the local embedder. If the dataset or the embedding model
    // changes on purpose, update this number and explain why in the commit.
    assert.equal(answerable.length, 25);
    assert.equal(answerable.filter((r) => r.score.retrievalAll).length, 23);
    assert.equal(answerable.filter((r) => r.score.retrievalTop1).length, 13);
    for (const r of saved.results) {
      assert.equal(r.answer, undefined);
      assert.equal('correct' in r.score, false);
      assert.equal('refused' in r.score, false);
    }
    const archived = fs.readdirSync(dir).filter((f) => /^latest\..*\.json$/.test(f));
    assert.deepEqual(archived, ['latest.20260102T030405Z.json']);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, archived[0]), 'utf8')).meta.mode, 'full');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('unknown flags and a missing --out value stop before anything is loaded or asked', () => {
  for (const [args, message] of [[['--retreival-only'], /unknown option/], [['--out'], /--out needs a file name/], [['--retry-errors', '--retrieval-only'], /cannot be combined/]]) {
    const result = run(args, os.tmpdir());
    assert.equal(result.status, 1);
    assert.match(result.stderr, message);
    assert.doesNotMatch(result.stderr, /TypeError/);
    assert.doesNotMatch(result.stdout, /Loading documents/);
  }
});

// ---- full mode with a scripted fake model (no Gemini, no key) ---------------------------------------------------
const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fakeLlm.mjs');
const fullRun = (args, cwd, mode, fallbackModel) => spawnSync(process.execPath, [runner, '--delay-ms', '0', ...args], {
  cwd,
  encoding: 'utf8',
  timeout: 120_000,
  env: { ...process.env, GOOGLE_API_KEY: '', EVAL_FAKE_LLM: fake, FAKE_LLM_MODE: mode, GEMINI_MODEL: 'gemini-3.5-flash-lite', GEMINI_FALLBACK_MODEL: fallbackModel },
});

test('full run with a fake model: the breaker stops after 5 errors, --retry-errors completes the same file, a fallback answer warns', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-fake-'));
  try {
    // 1. The main model always fails and there is no fallback: 5 errors, then every other question is skipped.
    const first = fullRun(['--out', 'run.json'], dir, 'main-503', 'none');
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /EVAL_FAKE_LLM/);
    const failed = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8'));
    assert.equal(failed.meta.fakeLlm, true);
    assert.equal(failed.results.length, 33);
    assert.deepEqual(failed.results.map((r) => r.error?.code).filter((c) => c === 'LLM_BUSY').length, 5);
    assert.equal(failed.results.filter((r) => r.error?.code === 'SKIPPED').length, 28);
    assert.equal(failed.results.filter((r) => r.answer !== undefined).length, 0);

    // 2. Retry with a healthy fake and the same settings: the same file is completed, nothing errors, the first run's metadata stays.
    const retry = fullRun(['--retry-errors', '--out', 'run.json'], dir, 'ok', 'none');
    assert.equal(retry.status, 0, retry.stderr);
    const done = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8'));
    assert.equal(done.meta.date, failed.meta.date);
    assert.equal(done.meta.retries.length, 1);
    assert.equal(done.meta.retries[0].ids.length, 33);
    assert.equal(done.results.filter((r) => r.error).length, 0);
    assert.equal(done.results.filter((r) => r.retried).length, 33);
    assert.equal(done.meta.answeredBy['gemini-3.5-flash-lite'], 33);
    assert.doesNotMatch(retry.stdout, /FALLBACK model/);

    // 3. The main model fails, the fallback answers: the run says so loudly and records who answered.
    const mixed = fullRun(['--out', 'mixed.json'], dir, 'fallback', 'gemini-3.1-flash-lite');
    assert.equal(mixed.status, 0, mixed.stderr);
    assert.match(mixed.stdout, /WARNING: 33 of 33 answers came from the FALLBACK model \(gemini-3\.1-flash-lite\)/);
    const mixedResults = JSON.parse(fs.readFileSync(path.join(dir, 'mixed.json'), 'utf8'));
    assert.equal(mixedResults.results.every((r) => r.answeredBy === 'gemini-3.1-flash-lite' && r.fallbackUsed), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a fake model never replaces the real one by accident: EVAL_FAKE_LLM is only read in full mode, and a bad module stops the run', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-fake-'));
  try {
    const broken = path.join(dir, 'broken.mjs');
    fs.writeFileSync(broken, 'export default { nothing: true };');
    const result = spawnSync(process.execPath, [runner, '--out', 'x.json'], { cwd: dir, encoding: 'utf8', env: { ...process.env, GOOGLE_API_KEY: '', EVAL_FAKE_LLM: broken } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /EVAL_FAKE_LLM must default-export \{ llm, fallbackLlm\? \}/);
    assert.equal(fs.existsSync(path.join(dir, 'x.json')), false);
    const retrievalOnly = spawnSync(process.execPath, [runner, '--retrieval-only', '--out', 'r.json'], { cwd: dir, encoding: 'utf8', env: { ...process.env, EVAL_FAKE_LLM: broken } });
    assert.equal(retrievalOnly.status, 0, retrievalOnly.stderr);
    assert.doesNotMatch(retrievalOnly.stdout, /EVAL_FAKE_LLM/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
