// Tests for the eval command-line parser (eval/args.js). Pure: no .env, key or model involved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseArgs } from '../eval/args.js';

test('defaults: a full run, 4 s between calls, results/latest.json', () => {
  const a = parseArgs([], '/work');
  assert.deepEqual([a.retrievalOnly, a.retryErrors, a.delayMs, a.out], [false, false, 4000, null]);
});

test('known flags and values are read; --out is resolved against the folder the command was run from', () => {
  const a = parseArgs(['--retrieval-only', '--delay-ms', '0', '--out', 'results/x.json'], '/work');
  assert.deepEqual([a.retrievalOnly, a.delayMs, a.out], [true, 0, path.resolve('/work', 'results/x.json')]);
  assert.equal(parseArgs(['--out', '/abs/y.json'], '/work').out, '/abs/y.json');
});

test('an unknown flag or a typo is rejected, so it never starts a paid full run', () => {
  for (const bad of [['--retreival-only'], ['--retrieval_only'], ['retrieval-only'], ['--delay-ms=5'], ['-r'], ['--help']]) {
    assert.throws(() => parseArgs(bad, '/work'), /unknown option/i, bad.join(' '));
  }
});

test('a value option without its value is rejected', () => {
  assert.throws(() => parseArgs(['--out'], '/work'), /--out needs a file/);
  assert.throws(() => parseArgs(['--out', '--retrieval-only'], '/work'), /--out needs a file/);
  assert.throws(() => parseArgs(['--delay-ms'], '/work'), /--delay-ms needs/);
  assert.throws(() => parseArgs(['--delay-ms', 'abc'], '/work'), /--delay-ms needs/);
  assert.throws(() => parseArgs(['--delay-ms', '-5'], '/work'), /--delay-ms needs/);
});

test('--retry-errors cannot be combined with --retrieval-only', () => {
  assert.throws(() => parseArgs(['--retry-errors', '--retrieval-only'], '/work'), /cannot be combined/);
});
