// Compares embedding models on the retrieval eval, each in its own process (so memory is its own):
//   node eval/embedders.js                       all candidates
//   node eval/embedders.js --only e5-small,gemma some of them (labels below)
//   node eval/embedders.js --only google-embedding-2   a hosted model: it spends Gemini API quota (about 40 embedding calls), so it only runs when named
//   node eval/embedders.js --resummarize         no model runs: re-score the stored raw runs (adds the chunk-level hit) and rebuild the summary
// For each model: (1) download it (a first process, so downloading is not part of the timings), (2) run
// `eval/run.js --retrieval-only` with that model (free: no Gemini call). Writes the raw runs to
// eval/results/embedders-raw/ (not committed) and the summary to eval/results/embedders-<date>.json (committed).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { summarizeRun } from './embedderSummary.js';
import { addChunkLevel } from './rescore.js';
import { loadChunkTexts } from './chunks.js';
import { resolveEmbeddingProfile } from '../src/services/embeddingProfile.js';

const evalDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(evalDir, '..');

// q8 (quantized) and one thread for all of them, as the app runs on Render. embeddinggemma has no fp16; q8 is what the card allows.
export const CANDIDATES = [
  { label: 'minilm-baseline', model: 'Xenova/all-MiniLM-L6-v2', dtype: 'q8' },
  { label: 'e5-small', model: 'Xenova/multilingual-e5-small', dtype: 'q8' },
  { label: 'e5-base', model: 'Xenova/multilingual-e5-base', dtype: 'q8' },
  { label: 'embeddinggemma-300m', model: 'onnx-community/embeddinggemma-300m-ONNX', dtype: 'q8' },
  { label: 'qwen3-embedding-0.6b', model: 'onnx-community/Qwen3-Embedding-0.6B-ONNX', dtype: 'q8' },
];

// Hosted candidates call the Google embeddings API with the GOOGLE_API_KEY of the project's .env (read by the child, never printed
// here). They are NOT in CANDIDATES, so a plain `node eval/embedders.js` never spends quota; only `--only <label>` runs them.
// No download step: nothing is stored locally, and the local model code is not loaded.
export const PAID_QUOTA_CANDIDATES = [
  { label: 'google-embedding-2', model: 'gemini-embedding-2', provider: 'google' },
  { label: 'google-embedding-001', model: 'gemini-embedding-001', provider: 'google' },
];
export const ALL = [...CANDIDATES, ...PAID_QUOTA_CANDIDATES];

/**
 * The environment for one candidate. .env is not read (DOTENV_CONFIG_PATH points at an empty file) and any EMBEDDING_*
 * variable of the caller is dropped, so the profile is the model's own and nothing from a developer's setup leaks in.
 */
export function envFor({ model, dtype, provider = 'local' }) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('EMBEDDING_')));
  if (provider === 'google') {
    // The child reads the project's .env for the key, and dotenv fills in every variable that is not set. So each EMBEDDING_* setting
    // is pinned: empty means unset for these, but an empty PREFIX would mean "no prefix", so the prefixes are pinned to the model's own.
    const own = resolveEmbeddingProfile(model, { EMBEDDING_PROVIDER: 'google' });
    const pinned = Object.fromEntries(['EMBEDDING_POOLING', 'EMBEDDING_DIMENSIONS', 'EMBEDDING_DTYPE', 'EMBEDDING_THREADS', 'EMBEDDING_SOURCE_MIN_SCORE', 'EMBEDDING_SOURCE_RELATIVE_SCORE'].map((key) => [key, '']));
    return { ...env, ...pinned, EMBEDDING_QUERY_PREFIX: own.queryPrefix.replaceAll('\n', '\\n'), EMBEDDING_DOCUMENT_PREFIX: own.documentPrefix.replaceAll('\n', '\\n'), DOTENV_CONFIG_PATH: path.join(root, '.env'), EMBEDDING_PROVIDER: 'google', EMBEDDING_MODEL: model };
  }
  return { ...env, DOTENV_CONFIG_PATH: os.devNull, EMBEDDING_MODEL: model, EMBEDDING_DTYPE: dtype, EMBEDDING_THREADS: '1' };
}

/** Bytes of the files the app downloaded for this model (the cache may hold other precisions from earlier runs). */
export function downloadedBytes(model, dtype) {
  const suffix = dtype === 'fp32' ? 'model' : { q8: 'model_quantized', fp16: 'model_fp16', q4: 'model_q4', q4f16: 'model_q4f16' }[dtype];
  const dir = path.join(root, '.cache', 'models', model);
  let total = 0;
  const walk = (folder) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (!folder.endsWith(`${path.sep}onnx`) || entry.name.startsWith(`${suffix}.onnx`)) total += fs.statSync(file).size;
    }
  };
  walk(dir);
  return total;
}

function run(args, env) {
  const result = spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { ok: result.status === 0, output: `${result.stdout}\n${result.stderr}`.trim() };
}

/** Without --only: the local candidates. Hosted ones (they spend API quota) run only when named. */
export function only(argv = process.argv) {
  const index = argv.indexOf('--only');
  if (index === -1) return CANDIDATES;
  const wanted = (argv[index + 1] ?? '').split(',');
  const unknown = wanted.filter((label) => !ALL.some((c) => c.label === label));
  if (unknown.length) throw new Error(`unknown candidate ${unknown.join(', ')}. Labels: ${ALL.map((c) => c.label).join(', ')}`);
  return ALL.filter((c) => wanted.includes(c.label));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const date = new Date().toISOString().slice(0, 10);
  const rawDir = path.join(evalDir, 'results', 'embedders-raw');
  fs.mkdirSync(rawDir, { recursive: true });
  const outFile = path.join(evalDir, 'results', `embedders-${date}.json`);
  // Models of an earlier, partial invocation stay in the summary unless they are measured again.
  const previous = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : null;
  const models = new Map((previous?.models ?? []).map((m) => [m.label, m]));

  // Written after every candidate, failures included, so an interrupted run keeps what it measured.
  const writeSummary = () => {
    const out = {
      date,
      note: 'Retrieval-only eval (eval/run.js --retrieval-only) per model, each in its own process, q8, 1 thread, top-4. Timings and memory are from this machine (not Render).',
      machine: { platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0]?.model, cores: os.cpus().length, node: process.version, transformers: JSON.parse(fs.readFileSync(path.join(root, 'node_modules', '@huggingface', 'transformers', 'package.json'), 'utf8')).version },
      // Hand-recorded measurements of the real server and of one answer run; a re-run of this script keeps them.
      ...(previous?.serverCheck ? { serverCheck: previous.serverCheck } : {}),
      ...(previous?.answerEval ? { answerEval: previous.answerEval } : {}),
      models: ALL.map((c) => models.get(c.label)).filter(Boolean),
    };
    fs.writeFileSync(outFile, `${JSON.stringify(out, null, 2)}\n`);
  };

  if (process.argv.includes('--resummarize')) {
    // No model is run: the stored raw runs hold every retrieved chunk, so the chunk-level score and the summary are recomputed.
    const { loadAndSplit } = await import('../src/services/documentLoader.js');
    const chunkText = await loadChunkTexts(path.join(evalDir, 'docs'), loadAndSplit);
    const questions = fs.readFileSync(path.join(evalDir, 'questions.jsonl'), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    for (const candidate of ALL) {
      const rawFile = path.join(rawDir, `${candidate.label}.json`);
      const old = models.get(candidate.label);
      if (!fs.existsSync(rawFile) || old?.status !== 'ok') continue;
      const rescored = addChunkLevel(JSON.parse(fs.readFileSync(rawFile, 'utf8')), questions, chunkText);
      fs.writeFileSync(rawFile, `${JSON.stringify(rescored, null, 2)}\n`);
      // Re-summarised with the rule of the CURRENT profile (the raw run saved the rule it was made with).
      const own = resolveEmbeddingProfile(candidate.model, { EMBEDDING_PROVIDER: candidate.provider ?? 'local' });
      models.set(candidate.label, { ...old, ...summarizeRun(rescored, { minScore: own.sourceMinScore, relativeScore: own.sourceRelativeScore }) });
      const { all } = models.get(candidate.label).retrieval;
      console.log(`${candidate.label}: right chunk in top-4 ${all.hitChunk.k}/${all.hitChunk.n}, file-level ${all.hitAll.k}/${all.n}`);
    }
    writeSummary();
    console.log(`Summary written to ${path.relative(root, outFile)}`);
    process.exit(0);
  }

  for (const candidate of only()) {
    console.log(`\n=== ${candidate.label}: ${candidate.model} (${candidate.provider === 'google' ? 'Google API' : candidate.dtype}) ===`);
    const env = envFor(candidate);
    const prefetchCode = "const { default: config } = await import('./src/config.js'); const { LocalEmbeddings } = await import('./src/services/embeddings.js'); await new LocalEmbeddings({ model: config.embeddingModel, dtype: config.embeddingDtype, threads: 1, profile: config.embeddingProfile }).embedQuery('download');";
    // A hosted model has nothing to download (and the local model code must not be loaded for it).
    const fetched = candidate.provider === 'google' ? { ok: true } : run(['--input-type=module', '-e', prefetchCode], env);
    if (!fetched.ok) {
      console.log(`download/load FAILED:\n${fetched.output.split('\n').slice(-6).join('\n')}`);
      models.set(candidate.label, { ...candidate, status: 'failed', error: fetched.output.split('\n').slice(-3).join(' | ').slice(0, 400) });
      writeSummary();
      continue;
    }
    const rawFile = path.join(rawDir, `${candidate.label}.json`);
    const evaluated = run([path.join('eval', 'run.js'), '--retrieval-only', '--out', rawFile], env);
    if (!evaluated.ok) {
      console.log(`eval FAILED:\n${evaluated.output.split('\n').slice(-6).join('\n')}`);
      models.set(candidate.label, { ...candidate, status: 'failed', error: evaluated.output.split('\n').slice(-3).join(' | ').slice(0, 400) });
      writeSummary();
      continue;
    }
    const summary = summarizeRun(JSON.parse(fs.readFileSync(rawFile, 'utf8')));
    const bytes = candidate.provider === 'google' ? null : downloadedBytes(candidate.model, candidate.dtype);
    models.set(candidate.label, { ...candidate, status: 'ok', ...(bytes === null ? {} : { downloadMb: Math.round(bytes / 1024 / 1024) }), ...summary });
    const { all, ar } = summary.retrieval;
    console.log(`all: hit-all ${all.hitAll.k}/${all.n}, top-1 ${all.top1.k}/${all.n} | ar top-1 ${ar.top1.k}/${ar.n}, ${summary.top1Spread.ar.distinctChunks} chunks first (most frequent ${summary.top1Spread.ar.mostFrequent} x${summary.top1Spread.ar.times}) | peak RSS ${summary.performance.peakRssMb} MB${summary.nearLimit ? ' (FLAGGED)' : ''}${bytes === null ? ` | ${summary.performance.apiCalls} API calls` : ` | download ${Math.round(bytes / 1024 / 1024)} MB`}`);
    writeSummary();
  }

  writeSummary();
  console.log(`\nSummary written to ${path.relative(root, outFile)}`);
}
