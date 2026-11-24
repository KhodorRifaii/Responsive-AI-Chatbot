// Eval runner: loads eval/docs through the app's real pipeline, asks every question in
// eval/questions.jsonl, scores retrieval, citations, answers and refusals, prints a table and
// writes the full results to a JSON file. Run it with `npm run eval` from the project folder.
//
//   npm run eval                          full run: real Gemini calls (about one per question)
//   npm run eval -- --retrieval-only      no Gemini calls: retrieval scores only (free)
//   npm run eval -- --retry-errors        re-ask only the questions that errored last time
//   options: --delay-ms N (pause between Gemini calls, default 4000)  --out FILE
// Offline tests only: EVAL_FAKE_LLM=<module> (full mode) replaces Gemini by the { llm, fallbackLlm } that the module
// exports. The results are marked fakeLlm and must never be published (see test/evalRun.test.js).
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from './args.js';
import { retryProblems } from './retry.js';
import { validateQuestions } from './validate.js';
import { loadChunkTexts } from './chunks.js';
import { wilson, analyzeLogs, chanceHitAll, latencyStats, scoreQuestion, summarize } from './score.js';

const evalDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(evalDir, '..');
function fail(message) {
  console.error(`eval: ${message}`);
  process.exit(1);
}

let options;
try {
  options = parseArgs(process.argv.slice(2), process.cwd());
} catch (error) {
  fail(error.message);
}
// The app reads .env from the working directory, so work from the project root from here on.
process.chdir(root);
const { retrievalOnly, retryErrors, delayMs } = options;
// A retrieval-only run is free and never touches the (paid) full-run file.
const outFile = options.out ?? path.join(evalDir, 'results', retrievalOnly ? 'retrieval.json' : 'latest.json');
const MAX_CONSECUTIVE_ERRORS = 5;

// ---- 1. Dataset checks, before any model is loaded --------------------------------------------
const docsDir = path.join(evalDir, 'docs');
const docFiles = fs.readdirSync(docsDir).filter((f) => !f.startsWith('.')).sort();
const docText = Object.fromEntries(docFiles.map((f) => [f, fs.readFileSync(path.join(docsDir, f), 'utf8')]));
// The app reads files with its own loaders (a CSV row becomes "Row 1: Branch: Central; ..."), so gold facts are
// checked against that parsed text, not the raw file. Loaded below, after the app's config is imported.
const { default: config } = await import('../src/config.js');
const { loadAndSplit } = await import('../src/services/documentLoader.js');
const { thinkingConfigFor } = await import('../src/services/thinking.js');
const parsedText = {};
for (const name of docFiles) {
  const chunks = await loadAndSplit({ originalname: name, buffer: Buffer.from(docText[name], 'utf8') }, name);
  parsedText[name] = chunks.map((c) => c.pageContent).join('\n');
}

// The text of each chunk, to check that a retrieved chunk really holds the gold facts (not only the right file).
const chunkText = await loadChunkTexts(docsDir, loadAndSplit);

function loadQuestions() {
  const lines = fs.readFileSync(path.join(evalDir, 'questions.jsonl'), 'utf8').split('\n').filter((l) => l.trim());
  return lines.map((line, i) => {
    try {
      return JSON.parse(line);
    } catch {
      return fail(`questions.jsonl line ${i + 1} is not valid JSON.`);
    }
  });
}

function checkQuestions(questions) {
  const { problems, warnings } = validateQuestions(questions, { docFiles, parsedText });
  for (const warning of warnings) console.warn(`eval: warning: ${warning}`);
  if (problems.length) fail(`dataset problems:\n  - ${problems.join('\n  - ')}`);
  const count = (keep) => questions.filter(keep).length;
  console.log(`Dataset: ${questions.length} questions (en ${count((q) => q.lang === 'en')}, ar ${count((q) => q.lang === 'ar')}; single ${count((q) => q.type === 'single')}, cross-lingual ${count((q) => q.type === 'cross-lingual')}, multi ${count((q) => q.type === 'multi')}, unanswerable ${count((q) => q.type === 'unanswerable')}), ${docFiles.length} documents. Gold facts found in their sources: OK. Alternatives shared with other documents and not explained: ${warnings.length}.`);
}

const questions = loadQuestions();
checkQuestions(questions);

// Fingerprint of the question file and every document: a retry must match it, or old answers could be scored against a changed set.
const datasetFingerprint = createHash('sha256')
  .update(fs.readFileSync(path.join(evalDir, 'questions.jsonl')))
  .update(JSON.stringify(docFiles.map((f) => [f, docText[f]])))
  .digest('hex')
  .slice(0, 16);

// ---- 2. The app's real pipeline ----------------------------------------------------------------
// A scripted fake model for offline tests of this runner. Loaded before the key check; with it no key is needed.
let fake = null;
if (!retrievalOnly && process.env.EVAL_FAKE_LLM) {
  try {
    fake = (await import(pathToFileURL(path.resolve(process.env.EVAL_FAKE_LLM)).href)).default;
  } catch (error) {
    fail(`EVAL_FAKE_LLM could not be loaded: ${error.message}`);
  }
  const runnable = (x) => typeof x?.invoke === 'function';
  if (!runnable(fake?.llm) || (fake.fallbackLlm !== undefined && !runnable(fake.fallbackLlm))) {
    fail('EVAL_FAKE_LLM must default-export { llm, fallbackLlm? } (runnables with an invoke method).');
  }
  console.log('!!! EVAL_FAKE_LLM: the answers come from a scripted fake model, not from Gemini. Never publish these results.');
}
if (!retrievalOnly && !fake && !config.googleApiKey) {
  fail('GOOGLE_API_KEY is missing. Add it to .env (free key: https://aistudio.google.com/app/apikey), or run with --retrieval-only.');
}
const { createSession, addDocument, search } = await import('../src/services/vectorStore.js');
const { answerQuestion, NOT_FOUND_ANSWER } = await import('../src/services/ragChain.js');

// What the app sends to each model as its thinking setting (null = the model's own default). Saved in the results and
// compared by a retry, so a retry can never mix two thinking settings.
const thinkingSettings = { level: config.geminiThinkingLevel, budget: config.geminiThinkingBudget };
const thinking = {
  main: thinkingConfigFor(config.geminiModel, thinkingSettings) ?? null,
  fallback: config.geminiFallbackModel ? thinkingConfigFor(config.geminiFallbackModel, thinkingSettings) ?? null : null,
};
const describeThinking = (t) => `${t.main ? JSON.stringify(t.main) : 'model default'}${t.fallback ? ` (fallback ${JSON.stringify(t.fallback)})` : ''}`;

// How the embedder was called (pooling, prefixes, size): saved in the results and compared by a retry.
const { pooling, normalize, queryPrefix, documentPrefix, dimensions, sourceMinScore, sourceRelativeScore } = config.embeddingProfile;
const embeddingProfile = { pooling, normalize, queryPrefix, documentPrefix, dimensions, sourceMinScore, sourceRelativeScore };

const previous = retryErrors && fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : null;
if (retryErrors && !previous) fail(`--retry-errors needs a previous results file (${path.relative(root, outFile)}).`);
const previousById = new Map((previous?.results ?? []).map((r) => [r.id, r]));
// A retry may only complete the same run (see retry.js). A file from a run that stopped half way is fine:
// questions missing from it are asked.
if (previous) {
  const settings = { mainModel: config.geminiModel, fallbackModel: config.geminiFallbackModel, thinking, fakeLlm: Boolean(fake), embeddingModel: config.embeddingModel, embeddingDtype: config.embeddingDtype, embeddingProfile, chunkSize: config.chunkSize, chunkOverlap: config.chunkOverlap, topK: config.topK, mode: 'full' };
  const problems = retryProblems(previous, { settings, fingerprint: datasetFingerprint, questionIds: questions.map((q) => q.id) });
  if (problems.length) fail(`--retry-errors cannot complete that file (${problems.join('; ')}). Run the eval again from the start instead.`);
}

console.log('Loading documents through the real pipeline (loader, splitter, local embeddings)...');
const session = createSession();
// Speed and memory of the embedder, for choosing one (see README "Choosing an embedder"). Heap = the highest value sampled.
const MB = 1024 * 1024;
let maxHeapMb = 0;
const sampleHeap = () => {
  maxHeapMb = Math.max(maxHeapMb, process.memoryUsage().heapUsed / MB);
};
// Searching the still empty store embeds one query, so this call loads the model (download excluded when it is cached).
let tick = performance.now();
await search(session, 'warm-up', 1);
const modelLoadMs = performance.now() - tick;
sampleHeap();
const chunksByFile = {};
tick = performance.now();
for (const name of docFiles) {
  const buffer = Buffer.from(docText[name], 'utf8');
  const info = await addDocument(session, { originalname: name, buffer, size: buffer.length });
  chunksByFile[name] = info.chunks;
  sampleHeap();
}
const docsEmbedMs = performance.now() - tick;
const vectorSize = session.store.memoryVectors[0]?.embedding.length ?? null;
const searchMs = [];
console.log(`Chunks: ${Object.entries(chunksByFile).map(([f, n]) => `${f} ${n}`).join(', ')} (total ${Object.values(chunksByFile).reduce((a, b) => a + b, 0)})`);

// ---- 3. Ask every question ---------------------------------------------------------------------
/**
 * Run fn with the app's console.warn/error captured (it logs fallbacks and provider errors there).
 * Returns { value } or { error }, plus the captured lines.
 */
async function captureLogs(fn) {
  const logs = [];
  const { warn, error } = console;
  console.warn = (...a) => logs.push(a.map(String).join(' '));
  console.error = (...a) => logs.push(a.map(String).join(' '));
  try {
    return { value: await fn(), logs };
  } catch (caught) {
    return { error: caught, logs };
  } finally {
    console.warn = warn;
    console.error = error;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const gitCommit = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
})();

const meta = previous ? { ...previous.meta } : {
  date: new Date().toISOString(),
  gitCommit,
  node: process.version,
  mode: retrievalOnly ? 'retrieval-only' : 'full',
  mainModel: config.geminiModel,
  fallbackModel: config.geminiFallbackModel,
  thinking,
  fakeLlm: Boolean(fake),
  embeddingModel: config.embeddingModel,
  embeddingDtype: config.embeddingDtype,
  embeddingProfile,
  chunkSize: config.chunkSize,
  chunkOverlap: config.chunkOverlap,
  topK: config.topK,
  chunksByFile,
  delayMs,
  judge: 'none (deterministic checks only)',
  datasetFingerprint,
};
if (previous) meta.retries = [...(previous.meta.retries ?? [])];

// A retry keeps the first run's metadata and lists each retry (date and question ids) under `retries`.
const retriedIds = [];
const records = [];
const results = [];
let consecutiveErrors = 0;
let llmCalls = 0;

/**
 * A full-run results file costs Gemini quota: before overwriting one (not when retrying it), move it to
 * latest.<date>.json next to it. Retrieval-only files are free and are simply replaced.
 */
function archiveFullRun(file) {
  if (!fs.existsSync(file)) return;
  let previousMeta = null;
  try {
    previousMeta = JSON.parse(fs.readFileSync(file, 'utf8')).meta;
  } catch {
    // Unreadable file: keep it too, under a .bak name.
  }
  if (previousMeta?.mode === 'retrieval-only') return;
  const stamp = String(previousMeta?.date ?? new Date(fs.statSync(file).mtime).toISOString()).replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const target = path.join(path.dirname(file), `latest.${stamp}${previousMeta ? '' : '.bak'}.json`);
  fs.renameSync(file, target);
  console.log(`Moved the existing results file to ${path.relative(root, target)}`);
}
if (!retryErrors) archiveFullRun(outFile);

function save() {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, `${JSON.stringify({ meta, results }, null, 2)}\n`);
}

for (const [index, q] of questions.entries()) {
  tick = performance.now();
  const retrievedPairs = await search(session, q.question, config.topK);
  searchMs.push(performance.now() - tick);
  sampleHeap();
  const retrieved = retrievedPairs.map(([chunk, score]) => ({ source: chunk.metadata.source, chunk: chunk.metadata.chunk, score: Number(score.toFixed(4)) }));
  const totalChunks = Object.values(chunksByFile).reduce((a, b) => a + b, 0);
  const run = {
    retrieved,
    // What a random pick would score: all expected files among k random chunks, and the first pick being one of their chunks.
    chance: q.sources.length ? chanceHitAll(q.sources, chunksByFile, config.topK) : null,
    chanceTop1: q.sources.length ? q.sources.reduce((sum, f) => sum + chunksByFile[f], 0) / totalChunks : null,
  };
  const old = previousById.get(q.id);

  if (!retrievalOnly) {
    if (old && !old.error) {
      Object.assign(run, { answer: old.answer, sources: old.sources, latencyMs: old.latencyMs, fallbackUsed: old.fallbackUsed, mainFailed: old.mainFailed, failedModels: old.failedModels, logs: old.logs, answeredBy: old.answeredBy });
    } else if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      run.error = { code: 'SKIPPED', message: `stopped after ${MAX_CONSECUTIVE_ERRORS} errors in a row` };
    } else {
      if (llmCalls > 0 && delayMs > 0) await sleep(delayMs);
      llmCalls += 1;
      if (previous) {
        retriedIds.push(q.id);
        run.retried = true;
      }
      const started = performance.now();
      const { value, error, logs } = await captureLogs(() => answerQuestion({ question: q.question, session, ...(fake ? { llm: fake.llm, fallbackLlm: fake.fallbackLlm } : {}) }));
      run.latencyMs = Math.round(performance.now() - started);
      Object.assign(run, analyzeLogs(logs, config.geminiModel));
      if (error) {
        run.answeredBy = null;
        run.error = { code: error.code ?? error.name ?? 'ERROR', status: error.status ?? null, message: String(error.message ?? error).slice(0, 200) };
        consecutiveErrors += 1;
      } else {
        run.answer = value.answer;
        run.sources = value.sources.map((src) => ({ source: src.source, page: src.page, chunk: src.chunk }));
        consecutiveErrors = 0;
      }
    }
  }
  const record = scoreQuestion(q, run, NOT_FOUND_ANSWER, chunkText);
  records.push(record);
  results.push({ id: q.id, lang: q.lang, type: q.type, question: q.question, expectedSources: q.sources, ...run, score: record });
  save();
  console.log(`[${index + 1}/${questions.length}] ${q.id}${run.error ? `  ERROR ${run.error.code}` : run.answer !== undefined ? `  ${record.answerable ? (record.correct ? 'correct' : 'WRONG') : record.refusedCorrectly ? 'refused' : 'NOT REFUSED'}  ${run.latencyMs ?? ''}ms` : ''}`);
}

// ---- 4. Summary --------------------------------------------------------------------------------
const summary = summarize(questions, records);
// "88% (22/25) [70-96]": share, count and the 95% Wilson interval (percent).
const pct = (share, n) => {
  if (share === null || n === 0) return '  n/a';
  const [low, high] = wilson(Math.round(share * n), n);
  return `${String(Math.round(share * 100)).padStart(3)}% (${Math.round(share * n)}/${n}) [${Math.round(low * 100)}-${Math.round(high * 100)}]`;
};
const num = (value, digits = 2) => (value === null ? 'n/a' : value.toFixed(digits));

console.log(`\nModels: main ${meta.mainModel}, fallback ${meta.fallbackModel ?? 'none'} | thinking ${describeThinking(meta.thinking)} | embeddings ${meta.embeddingModel} (${meta.embeddingDtype}) | top-${meta.topK}, chunks ${meta.chunkSize}/${meta.chunkOverlap}`);
console.log('\nRETRIEVAL (answerable questions; hit = expected file(s) among the top-k chunks; right chunk = every gold fact is in a retrieved chunk of an expected file)');
console.log(`${'slice'.padEnd(14)}${'n'.padStart(3)}  ${'all expected files in top-k'.padEnd(38)}${'any expected file'.padEnd(32)}${'top-1 is expected'.padEnd(32)}${'right chunk in top-k'.padEnd(32)}random: top-k / top-1`);
for (const [name, g] of Object.entries(summary)) {
  if (g.answerable === 0) continue;
  console.log(`${name.padEnd(14)}${String(g.answerable).padStart(3)}  ${pct(g.retrievalAll, g.answerable).padEnd(38)}${pct(g.retrievalAny, g.answerable).padEnd(32)}${pct(g.retrievalTop1, g.answerable).padEnd(32)}${pct(g.retrievalChunk, g.answerable).padEnd(32)}${Math.round(g.chance * 100)}% / ${Math.round(g.chanceTop1 * 100)}%`);
}
if (!retrievalOnly) {
  console.log('\nANSWERS (answerable questions that got an answer; correct = every gold fact present, not negated, not a refusal)');
  console.log(`${'slice'.padEnd(14)}${'n'.padStart(3)}  ${'correct (facts)'.padEnd(32)}${'correct + sources shown'.padEnd(32)}${'mean fact recall'.padEnd(18)}false refusals`);
  for (const [name, g] of Object.entries(summary)) {
    if (g.answeredCount === 0) continue;
    console.log(`${name.padEnd(14)}${String(g.answeredCount).padStart(3)}  ${pct(g.correct, g.answeredCount).padEnd(32)}${pct(g.correctAndCited, g.answeredCount).padEnd(32)}${`${Math.round(g.factRecall * 100)}%`.padEnd(18)}${g.falseRefusals}`);
  }
  const none = summary.unanswerable;
  console.log(`\nREFUSALS (unanswerable questions): exact "not found" sentence and no sources ${pct(none.refused, none.unansweredCount)}; loosely refused (EN/AR phrases) ${pct(none.softRefused, none.unansweredCount)}`);
  const byModel = {};
  for (const r of results) if (r.answeredBy) byModel[r.answeredBy] = (byModel[r.answeredBy] ?? 0) + 1;
  console.log(`\nAnswered by: ${Object.entries(byModel).map(([model, n]) => `${model} ${n}`).join(', ') || 'nobody'}`);
  const viaFallback = results.filter((r) => r.fallbackUsed).length;
  if (viaFallback) {
    console.log(`\n!!! WARNING: ${viaFallback} of ${results.length} answers came from the FALLBACK model (${meta.fallbackModel}), not ${meta.mainModel}. These results MIX models. For a single-model run use GEMINI_FALLBACK_MODEL=none.`);
  }
  const times = results.filter((r) => r.latencyMs !== undefined && !r.error).map((r) => r.latencyMs);
  const stats = latencyStats(times);
  const errored = results.filter((r) => r.error);
  console.log(`\nLatency per answer: ${stats ? `mean ${Math.round(stats.mean)} ms, median ${Math.round(stats.median)} ms, max ${stats.max} ms` : 'n/a'} | answered by the fallback model: ${results.filter((r) => r.fallbackUsed).length} | main model failed first: ${results.filter((r) => r.mainFailed).length} | errored: ${errored.length}${errored.length ? ` (${errored.map((r) => `${r.id}:${r.error.code}`).join(', ')})` : ''}`);
}
// Retrieval collapse: does one chunk come first for most questions of a language?
for (const lang of ['en', 'ar']) {
  const firsts = results.filter((r) => r.lang === lang).map((r) => `${r.retrieved[0].source}#${r.retrieved[0].chunk}`);
  const counts = new Map();
  for (const f of firsts) counts.set(f, (counts.get(f) ?? 0) + 1);
  const [top, times] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  console.log(`Top-1 spread (${lang} questions): ${counts.size} different chunks first in ${firsts.length} questions; the most frequent, ${top}, is first ${times} times`);
}
console.log(`Top-1 similarity: answerable ${num(summary.all.topScoreAnswerable)} vs unanswerable ${num(summary.all.topScoreUnanswerable)} (cosine)`);

// Questions to read by hand: the deterministic checks can miss a correct paraphrase.
const flagged = results.filter((r) => {
  const s = r.score;
  if (r.error) return false;
  if (!s.answerable) return retrievalOnly ? false : !s.refusedCorrectly;
  return !s.retrievalAll || (!retrievalOnly && (!s.correct || !s.citedAll));
});
if (flagged.length) {
  console.log('\nFLAGGED (read these by hand):');
  for (const r of flagged) {
    const s = r.score;
    const why = [!s.answerable ? (s.softRefused ? 'refused in other words' : 'answered an unanswerable question') : '', s.answerable && !s.retrievalAll ? 'retrieval miss' : '', s.answerable && s.correct === false ? `facts ${JSON.stringify(s.factsFound)}${s.refused ? ' (refused)' : ''}` : '', s.answerable && s.citedAll === false ? 'sources not cited' : ''].filter(Boolean).join('; ');
    console.log(`- ${r.id} [${why}] top-k: ${r.retrieved.map((x) => `${x.source} ${x.score}`).join(', ')}${r.answer !== undefined ? `\n    answer: ${r.answer.replace(/\s+/g, ' ').slice(0, 160)}` : ''}`);
  }
}

const sortedSearch = [...searchMs].sort((a, b) => a - b);
// maxRSS is in kilobytes (Node docs): the peak memory of this whole process, model loading included.
const performanceStats = {
  modelLoadMs: Math.round(modelLoadMs),
  docsEmbedMs: Math.round(docsEmbedMs),
  chunks: Object.values(chunksByFile).reduce((a, b) => a + b, 0),
  searchMsMean: Math.round(searchMs.reduce((a, b) => a + b, 0) / searchMs.length),
  searchMsMedian: Math.round(sortedSearch[Math.floor(sortedSearch.length / 2)]),
  peakRssMb: Math.round(process.resourceUsage().maxRSS / 1024),
  maxHeapMb: Math.round(maxHeapMb),
  vectorSize,
};
console.log(`\nEmbedder speed and memory: model load ${performanceStats.modelLoadMs} ms, ${performanceStats.chunks} chunks embedded in ${performanceStats.docsEmbedMs} ms, search (query embedding included) mean ${performanceStats.searchMsMean} ms / median ${performanceStats.searchMsMedian} ms, peak memory (RSS) ${performanceStats.peakRssMb} MB, highest JS heap sampled ${performanceStats.maxHeapMb} MB, vector size ${performanceStats.vectorSize}`);
// A retry keeps the first run's metadata (and so its performance): the retry only re-asks a few questions and re-embeds the corpus, so its timings would not describe the run.
if (!previous) meta.performance = performanceStats;
meta.summary = summary;
meta.answeredBy = Object.fromEntries(results.filter((r) => r.answeredBy).reduce((m, r) => m.set(r.answeredBy, (m.get(r.answeredBy) ?? 0) + 1), new Map()));
if (previous) meta.retries.push({ date: new Date().toISOString(), ids: retriedIds });
save();
console.log(`\nResults written to ${path.relative(root, outFile)}`);
// Safety net: if a native library keeps the process alive, leave after two seconds.
setTimeout(() => process.exit(0), 2000).unref();
