import './env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const script = fileURLToPath(new URL('./fixtures/streamDrop.mjs', import.meta.url));

test('a Gemini stream that drops mid-answer ends that answer, without crashing the server', async () => {
  // Rejects (exit code 1) if the process dies from the SDK's unhandled rejection.
  const { stdout } = await run(process.execPath, [script], { timeout: 60_000 });
  const result = JSON.parse(stdout.trim().split('\n').at(-1));
  assert.deepEqual(result, { code: 'LLM_ERROR', tokens: '18 months', alive: true });
});
