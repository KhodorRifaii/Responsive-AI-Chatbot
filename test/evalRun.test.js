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
