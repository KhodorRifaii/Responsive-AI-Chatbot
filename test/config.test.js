import './env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** config.geminiTimeoutSeconds for a given GEMINI_TIMEOUT_SECONDS (config is read once per process). */
async function timeoutFor(value) {
  const code = "const { default: config } = await import('./src/config.js'); console.log(config.geminiTimeoutSeconds);";
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, GEMINI_TIMEOUT_SECONDS: value },
  });
  return Number(stdout.trim());
}

test('GEMINI_TIMEOUT_SECONDS accepts sensible values and falls back to 30 otherwise', async () => {
  assert.equal(await timeoutFor('45'), 45);
  assert.equal(await timeoutFor('0.5'), 0.5);
  // setTimeout would fire at once for these, so every answer would time out.
  for (const value of ['Infinity', '1e100', '2147484', '-5', '0', 'abc']) {
    assert.equal(await timeoutFor(value), 30, value);
  }
});
