import './env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const run = promisify(execFile);
const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

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

// Runs `code` in a fresh process in an empty folder (so no .env is read) with only the given settings, and returns its output.
async function inFreshProcess(settings, code) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-'));
  try {
    const configUrl = pathToFileURL(path.join(projectRoot, 'src', 'config.js')).href;
    const ragUrl = pathToFileURL(path.join(projectRoot, 'src', 'services', 'ragChain.js')).href;
    const { stdout } = await run(process.execPath, ['--input-type=module', '-e', `const { default: config } = await import(${JSON.stringify(configUrl)}); const rag = await import(${JSON.stringify(ragUrl)}); ${code}`], {
      cwd: dir,
      env: { PATH: process.env.PATH, ...settings },
    });
    return stdout.trim();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('GEMINI_THINKING_LEVEL accepts the four levels and "default", and falls back to minimal otherwise', async () => {
  const read = (value) => inFreshProcess({ GEMINI_THINKING_LEVEL: value }, 'console.log(JSON.stringify(config.geminiThinkingLevel));');
  for (const level of ['minimal', 'low', 'medium', 'high']) assert.equal(await read(level), `"${level}"`);
  assert.equal(await read(' HIGH '), '"high"');
  assert.equal(await read('default'), 'null');
  for (const value of ['', 'xhigh', 'off', '0']) assert.equal(await read(value), '"minimal"', value);
});

test('createLlm sends each model the thinking setting its family accepts (no network)', async () => {
  const code = `
    const show = (model) => console.log(model, JSON.stringify(rag.createLlm(model).thinkingConfig ?? null));
    for (const model of ['gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemini-2.5-flash', 'gemini-4-argon']) show(model);`;
  const out = await inFreshProcess({ GOOGLE_API_KEY: 'fake-key-for-test' }, code);
  assert.equal(out, [
    'gemini-3.5-flash-lite {"thinkingLevel":"minimal"}',
    'gemini-3.8-flash {"thinkingLevel":"low"}',
    'gemini-2.5-flash {"thinkingBudget":0}',
    'gemini-4-argon null',
  ].join('\n'));
});
