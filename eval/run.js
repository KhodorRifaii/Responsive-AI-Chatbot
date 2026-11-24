// Eval runner: loads eval/docs through the app's real pipeline, asks every question in
// eval/questions.jsonl, scores retrieval, citations, answers and refusals, prints a table and
// writes the full results to a JSON file. Run it with `npm run eval` from the project folder.
//
//   npm run eval                          full run: real Gemini calls (about one per question)
//   npm run eval -- --retrieval-only      no Gemini calls: retrieval scores only (free)
//   npm run eval -- --retry-errors        re-ask only the questions that errored last time
//   options: --delay-ms N (pause between Gemini calls, default 4000)  --out FILE
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chanceHitAll, findCollisions, hasFact, latencyStats, normalize, scoreQuestion, summarize } from './score.js';

const evalDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(evalDir, '..');
// The app reads .env from the working directory, so always work from the project root.
process.chdir(root);

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const retrievalOnly = flag('--retrieval-only');
const retryErrors = flag('--retry-errors');
const delayMs = Number(option('--delay-ms', 4000));
const outFile = path.resolve(option('--out', path.join(evalDir, 'results', 'latest.json')));
const MAX_CONSECUTIVE_ERRORS = 5;

function fail(message) {
  console.error(`eval: ${message}`);
  process.exit(1);
}
if (retrievalOnly && retryErrors) fail('--retry-errors cannot be combined with --retrieval-only.');
if (!Number.isFinite(delayMs) || delayMs < 0) fail('--delay-ms must be a number of milliseconds (0 or more).');

// ---- 1. Dataset checks, before any model is loaded --------------------------------------------
const docsDir = path.join(evalDir, 'docs');
const docFiles = fs.readdirSync(docsDir).filter((f) => !f.startsWith('.')).sort();
const docText = Object.fromEntries(docFiles.map((f) => [f, fs.readFileSync(path.join(docsDir, f), 'utf8')]));
// The app reads files with its own loaders (a CSV row becomes "Row 1: Branch: Central; ..."), so gold facts are
// checked against that parsed text, not the raw file. Loaded below, after the app's config is imported.
const { default: config } = await import('../src/config.js');
const { loadAndSplit } = await import('../src/services/documentLoader.js');
const parsedText = {};
for (const name of docFiles) {
  const chunks = await loadAndSplit({ originalname: name, buffer: Buffer.from(docText[name], 'utf8') }, name);
  parsedText[name] = chunks.map((c) => c.pageContent).join('\n');
}

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

function validateQuestions(questions) {
  const problems = [];
  const seen = new Set();
  const TYPES = ['single', 'multi', 'cross-lingual', 'unanswerable'];
  for (const q of questions) {
    const where = q.id ?? '(no id)';
    if (!q.id || seen.has(q.id)) problems.push(`${where}: missing or duplicate id`);
    seen.add(q.id);
    if (!['en', 'ar'].includes(q.lang)) problems.push(`${where}: lang must be en or ar`);
    if (!TYPES.includes(q.type)) problems.push(`${where}: unknown type ${q.type}`);
    if (typeof q.question !== 'string' || !q.question.trim()) problems.push(`${where}: empty question`);
    if (!Array.isArray(q.sources) || !Array.isArray(q.facts)) {
      problems.push(`${where}: sources and facts must be arrays`);
      continue;
    }
    for (const s of q.sources) if (!docText[s]) problems.push(`${where}: source ${s} is not in eval/docs`);
    if (q.type === 'unanswerable') {
      if (q.sources.length || q.facts.length) problems.push(`${where}: unanswerable questions have no sources or facts`);
      continue;
    }
    if (q.sources.length < (q.type === 'multi' ? 2 : 1)) problems.push(`${where}: too few sources for type ${q.type}`);
    if (q.facts.length === 0) problems.push(`${where}: answerable questions need at least one fact`);
    // Every gold fact must appear in its source text (catches typos in the gold set).
    const sourceText = q.sources.map((s) => parsedText[s] ?? '').join('\n');
    for (const alternatives of q.facts) {
      if (!Array.isArray(alternatives) || alternatives.length === 0) problems.push(`${where}: a fact needs a list of alternatives`);
      else if (!hasFact(sourceText, alternatives)) problems.push(`${where}: no alternative of ${JSON.stringify(alternatives)} is found in its sources`);
    }
  }
  // Warn (not fail) when a gold alternative also appears in a document that is not an expected source.
  const warnings = questions.flatMap((q) => (Array.isArray(q.sources) && Array.isArray(q.facts) ? findCollisions(q, parsedText).map((c) => `${q.id}: "${c.alternative}" also appears in ${c.file}`) : []));
  for (const warning of warnings) console.warn(`eval: warning: ${warning}`);
  if (problems.length) fail(`dataset problems:\n  - ${problems.join('\n  - ')}`);
  const count = (keep) => questions.filter(keep).length;
  console.log(`Dataset: ${questions.length} questions (en ${count((q) => q.lang === 'en')}, ar ${count((q) => q.lang === 'ar')}; single ${count((q) => q.type === 'single')}, cross-lingual ${count((q) => q.type === 'cross-lingual')}, multi ${count((q) => q.type === 'multi')}, unanswerable ${count((q) => q.type === 'unanswerable')}), ${docFiles.length} documents. Gold facts found in their sources: OK. Alternatives shared with other documents: ${warnings.length}.`);
}

const questions = loadQuestions();
validateQuestions(questions);

// Fingerprint of the question file and every document: a retry must match it, or old answers could be scored against a changed set.
const datasetFingerprint = createHash('sha256')
  .update(fs.readFileSync(path.join(evalDir, 'questions.jsonl')))
  .update(JSON.stringify(docFiles.map((f) => [f, docText[f]])))
  .digest('hex')
  .slice(0, 16);

// ---- 2. The app's real pipeline ----------------------------------------------------------------
if (!retrievalOnly && !config.googleApiKey) {
  fail('GOOGLE_API_KEY is missing. Add it to .env (free key: https://aistudio.google.com/app/apikey), or run with --retrieval-only.');
}
const { createSession, addDocument, search } = await import('../src/services/vectorStore.js');
const { answerQuestion, NOT_FOUND_ANSWER } = await import('../src/services/ragChain.js');

const previous = retryErrors && fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : null;
if (retryErrors && !previous) fail(`--retry-errors needs a previous results file (${path.relative(root, outFile)}).`);
const previousById = new Map((previous?.results ?? []).map((r) => [r.id, r]));
// A retry may only complete the same run: same models, settings and documents, or the file would mix two runs.
const SETTINGS = ['mainModel', 'fallbackModel', 'thinkingBudget', 'embeddingModel', 'embeddingDtype', 'chunkSize', 'chunkOverlap', 'topK', 'mode'];
if (previous) {
  const now = { mainModel: config.geminiModel, fallbackModel: config.geminiFallbackModel, thinkingBudget: config.geminiThinkingBudget, embeddingModel: config.embeddingModel, embeddingDtype: config.embeddingDtype, chunkSize: config.chunkSize, chunkOverlap: config.chunkOverlap, topK: config.topK, mode: 'full' };
  const changed = SETTINGS.filter((key) => JSON.stringify(previous.meta?.[key]) !== JSON.stringify(now[key]));
  if (previous.meta?.datasetFingerprint !== datasetFingerprint) changed.push('questions or documents');
  const priorIds = (previous.results ?? []).map((r) => r.id).sort().join();
  if (priorIds !== questions.map((q) => q.id).sort().join()) changed.push('question ids');
  if (changed.length) fail(`--retry-errors needs the same settings, questions and documents as the first run (different: ${changed.join(', ')}). Run the eval again from the start instead.`);
}

console.log('Loading documents through the real pipeline (loader, splitter, local embeddings)...');
const session = createSession();
const chunksByFile = {};
for (const name of docFiles) {
  const buffer = Buffer.from(docText[name], 'utf8');
  const info = await addDocument(session, { originalname: name, buffer, size: buffer.length });
  chunksByFile[name] = info.chunks;
}
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
  thinkingBudget: config.geminiThinkingBudget,
  embeddingModel: config.embeddingModel,
  embeddingDtype: config.embeddingDtype,
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

function save() {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, `${JSON.stringify({ meta, results }, null, 2)}\n`);
}

for (const [index, q] of questions.entries()) {
  const retrievedPairs = await search(session, q.question, config.topK);
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
      Object.assign(run, { answer: old.answer, sources: old.sources, latencyMs: old.latencyMs, fallbackUsed: old.fallbackUsed, mainFailed: old.mainFailed, mainFailure: old.mainFailure });
    } else if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      run.error = { code: 'SKIPPED', message: `stopped after ${MAX_CONSECUTIVE_ERRORS} errors in a row` };
    } else {
      if (llmCalls > 0 && delayMs > 0) await sleep(delayMs);
      llmCalls += 1;
      if (old) retriedIds.push(q.id);
      const started = performance.now();
      const { value, error, logs } = await captureLogs(() => answerQuestion({ question: q.question, session }));
      run.latencyMs = Math.round(performance.now() - started);
      // The app logs "LLM fallback: <main> failed (...)" and "LLM answered with fallback model <name>".
      const failure = logs.find((l) => l.startsWith('LLM fallback:'));
      run.mainFailed = Boolean(failure);
      run.mainFailure = failure?.slice(0, 200) ?? null;
      run.fallbackUsed = logs.some((l) => l.startsWith('LLM answered with fallback model'));
      if (error) {
        run.error = { code: error.code ?? error.name ?? 'ERROR', status: error.status ?? null, message: String(error.message ?? error).slice(0, 200) };
        consecutiveErrors += 1;
      } else {
        run.answer = value.answer;
        run.sources = value.sources.map((src) => ({ source: src.source, page: src.page, chunk: src.chunk }));
        consecutiveErrors = 0;
      }
    }
  }
  const record = scoreQuestion(q, run, NOT_FOUND_ANSWER);
  records.push(record);
  results.push({ id: q.id, lang: q.lang, type: q.type, question: q.question, expectedSources: q.sources, ...run, score: record });
  save();
  console.log(`[${index + 1}/${questions.length}] ${q.id}${run.error ? `  ERROR ${run.error.code}` : run.answer !== undefined ? `  ${record.answerable ? (record.correct ? 'correct' : 'WRONG') : record.refusedCorrectly ? 'refused' : 'NOT REFUSED'}  ${run.latencyMs ?? ''}ms` : ''}`);
}

// ---- 4. Summary --------------------------------------------------------------------------------
const summary = summarize(questions, records);
const pct = (share, n) => (share === null || n === 0 ? '  n/a' : `${String(Math.round(share * 100)).padStart(3)}% (${Math.round(share * n)}/${n})`);
const num = (value, digits = 2) => (value === null ? 'n/a' : value.toFixed(digits));

console.log(`\nModels: main ${meta.mainModel}, fallback ${meta.fallbackModel ?? 'none'} | thinking budget ${meta.thinkingBudget ?? 'default'} | embeddings ${meta.embeddingModel} (${meta.embeddingDtype}) | top-${meta.topK}, chunks ${meta.chunkSize}/${meta.chunkOverlap}`);
console.log('\nRETRIEVAL (answerable questions; hit = expected file(s) among the top-k chunks)');
console.log(`${'slice'.padEnd(14)}${'n'.padStart(3)}  ${'all expected files in top-k'.padEnd(28)}${'any expected file'.padEnd(22)}${'top-1 is expected'.padEnd(22)}random: top-k / top-1`);
for (const [name, g] of Object.entries(summary)) {
  if (g.answerable === 0) continue;
  console.log(`${name.padEnd(14)}${String(g.answerable).padStart(3)}  ${pct(g.retrievalAll, g.answerable).padEnd(28)}${pct(g.retrievalAny, g.answerable).padEnd(22)}${pct(g.retrievalTop1, g.answerable).padEnd(22)}${Math.round(g.chance * 100)}% / ${Math.round(g.chanceTop1 * 100)}%`);
}
if (!retrievalOnly) {
  console.log('\nANSWERS (answerable questions that got an answer; correct = every gold fact present and not a refusal)');
  console.log(`${'slice'.padEnd(14)}${'n'.padStart(3)}  ${'correct'.padEnd(18)}${'mean fact recall'.padEnd(18)}${'sources cited'.padEnd(18)}false refusals`);
  for (const [name, g] of Object.entries(summary)) {
    if (g.answeredCount === 0) continue;
    console.log(`${name.padEnd(14)}${String(g.answeredCount).padStart(3)}  ${pct(g.correct, g.answeredCount).padEnd(18)}${`${Math.round(g.factRecall * 100)}%`.padEnd(18)}${pct(g.citedAll, g.answeredCount).padEnd(18)}${g.falseRefusals}`);
  }
  const none = summary.unanswerable;
  console.log(`\nREFUSALS (unanswerable questions): exact "not found" sentence and no sources ${pct(none.refused, none.unansweredCount)}; loosely refused (EN/AR phrases) ${pct(none.softRefused, none.unansweredCount)}`);
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

meta.summary = summary;
if (previous) meta.retries.push({ date: new Date().toISOString(), ids: retriedIds });
save();
console.log(`\nResults written to ${path.relative(root, outFile)}`);
// Safety net: if a native library keeps the process alive, leave after two seconds.
setTimeout(() => process.exit(0), 2000).unref();
