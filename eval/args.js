// Command-line options of eval/run.js. Anything unknown is an error, so a typo (--retreival-only)
// can never start a full run that spends Gemini quota.
import path from 'node:path';

/**
 * @param {string[]} argv options after the script name
 * @param {string} cwd folder the command was run from (a relative --out is resolved against it)
 */
export function parseArgs(argv, cwd) {
  const result = { retrievalOnly: false, retryErrors: false, delayMs: 4000, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--retrieval-only') result.retrievalOnly = true;
    else if (arg === '--retry-errors') result.retryErrors = true;
    else if (arg === '--delay-ms') {
      const value = argv[(i += 1)];
      const ms = Number(value);
      if (value === undefined || value.trim() === '' || !Number.isFinite(ms) || ms < 0) throw new Error('--delay-ms needs a number of milliseconds (0 or more).');
      result.delayMs = ms;
    } else if (arg === '--out') {
      const value = argv[(i += 1)];
      if (!value || value.startsWith('--')) throw new Error('--out needs a file name.');
      result.out = path.resolve(cwd, value);
    } else {
      throw new Error(`unknown option "${arg}". Options: --retrieval-only, --retry-errors, --delay-ms N, --out FILE.`);
    }
  }
  if (result.retrievalOnly && result.retryErrors) throw new Error('--retry-errors cannot be combined with --retrieval-only.');
  return result;
}
