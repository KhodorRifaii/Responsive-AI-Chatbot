// Deterministic scoring for the eval. Pure functions: no config, no network, nothing from src/.
// Matching policy (documented in the README): text is normalised, split into tokens, and a gold
// alternative must appear as a run of whole tokens in the answer. No raw substring matching.

/** Lowercase, unify Arabic spellings, turn Arabic/Persian digits into ASCII, drop thousands separators. */
export function normalize(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, '') // Arabic diacritics and tatweel
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, '.')
    .replace(/(?<=\d)[,٬،](?=\d{3}(?!\d))/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Numbers (with an optional decimal part) and runs of letters. "ب30" gives "ب", "30"; "10:00" gives "10", "00". */
export function tokens(text) {
  return normalize(text).match(/\d+(?:\.\d+)?|\p{L}+/gu) ?? [];
}

// Attached Arabic articles, prepositions and conjunctions that may precede a gold word in an answer.
const PREFIXES = new Set(['و', 'ف', 'ب', 'ل', 'ك', 'س', 'ال', 'وال', 'فال', 'بال', 'كال', 'لل', 'ولل']);
const ARABIC = /^[؀-ۿ]+$/;

/**
 * Does an answer token match a gold token? Equal, or (Arabic gold words of 3+ letters only) equal to
 * one of the closed-list prefixes followed by the gold word. Nothing is ever stripped from the answer
 * token on its own, so an answer containing only "تاب" never satisfies the gold word "كتاب".
 */
function tokenMatches(answerToken, goldToken) {
  if (answerToken === goldToken) return true;
  if (!ARABIC.test(goldToken) || goldToken.length < 3 || answerToken.length <= goldToken.length) return false;
  return answerToken.endsWith(goldToken) && PREFIXES.has(answerToken.slice(0, answerToken.length - goldToken.length));
}

/** True when any alternative appears as a consecutive run of tokens in the text. */
export function hasFact(text, alternatives) {
  const words = tokens(text);
  return alternatives.some((alternative) => {
    const gold = tokens(alternative);
    if (gold.length === 0) return false;
    for (let start = 0; start + gold.length <= words.length; start += 1) {
      if (gold.every((g, i) => tokenMatches(words[start + i], g))) return true;
    }
    return false;
  });
}

// "Not found" phrases in English and Arabic (after normalize), to see refusals that are not the app's exact sentence.
const SOFT_REFUSAL = new RegExp([
  "couldn[’']?t find|could not find|can[’']?t find|cannot find",
  'not (?:found|mentioned|stated|provided|specified|available|included)',
  'no (?:information|mention|details)',
  "(?:does not|doesn[’']?t|do not|don[’']?t) (?:mention|say|state|contain|specify|provide|know|have)",
  "(?:isn[’']?t|is not) (?:mentioned|stated|specified)",
  'لم (?:اجد|يرد|يذكر|اعثر|تذكر|ترد)',
  'لا (?:يوجد|توجد|تتوفر|يتوفر|اعرف|يذكر|تذكر|تحتوي|تتضمن|اجد)',
  'غير (?:موجود|مذكور|متوفر|متاح|وارد)',
].join('|'));

/** The app's own refusal: the answer is exactly the "not found" sentence (nothing before or after it). */
export const isRefusal = (answer, notFoundAnswer) => normalize(answer) === normalize(notFoundAnswer);
export const isSoftRefusal = (answer) => SOFT_REFUSAL.test(normalize(answer));

const choose = (n, k) => {
  if (k < 0 || k > n) return 0;
  let value = 1;
  for (let i = 1; i <= k; i += 1) value = (value * (n - k + i)) / i;
  return value;
};

/**
 * Chance that k chunks drawn at random (no repeats) from all chunks include at least one chunk of EACH
 * expected file. chunksByFile: { file: chunkCount }. Inclusion-exclusion over the files that are missed.
 */
export function chanceHitAll(expectedFiles, chunksByFile, k) {
  const total = Object.values(chunksByFile).reduce((a, b) => a + b, 0);
  const sizes = expectedFiles.map((f) => chunksByFile[f] ?? 0);
  let probability = 0;
  for (let mask = 0; mask < 1 << sizes.length; mask += 1) {
    let missed = 0;
    let bits = 0;
    sizes.forEach((size, i) => {
      if (mask & (1 << i)) {
        missed += size;
        bits += 1;
      }
    });
    probability += (bits % 2 ? -1 : 1) * (choose(total - missed, k) / choose(total, k));
  }
  return probability;
}

const unique = (list) => [...new Set(list)];

/**
 * Score one question. run = { retrieved: [{ source, score }], answer, sources: [{ source }], error }.
 * Answerable questions get retrieval, citation and answer scores; unanswerable ones a refusal score.
 * A run with an error has no answer scores (it is reported as errored, not as wrong); a run with no
 * answer at all (retrieval-only) gets the retrieval fields only.
 */
export function scoreQuestion(question, run, notFoundAnswer) {
  const answerable = question.sources.length > 0;
  const files = unique((run.retrieved ?? []).map((r) => r.source));
  const record = { id: question.id, answerable, topScore: run.retrieved?.[0]?.score ?? null };
  if (answerable) {
    record.retrievalAll = question.sources.every((s) => files.includes(s));
    record.retrievalAny = question.sources.some((s) => files.includes(s));
    record.retrievalTop1 = question.sources.includes(run.retrieved?.[0]?.source);
    record.chance = run.chance ?? null;
    record.chanceTop1 = run.chanceTop1 ?? null;
  }
  if (run.error) return { ...record, errored: true };
  // No answer was asked for (retrieval-only run): only retrieval fields, never fake answer scores.
  if (run.answer === undefined) return { ...record, noAnswer: true };
  const cited = unique((run.sources ?? []).map((s) => s.source));
  record.refused = isRefusal(run.answer, notFoundAnswer);
  // Loose flag: any "not found" wording, including the exact sentence inside a longer answer.
  record.softRefused = record.refused || isSoftRefusal(run.answer) || normalize(run.answer).includes(normalize(notFoundAnswer));
  if (answerable) {
    record.citedAll = question.sources.every((s) => cited.includes(s));
    record.factsFound = question.facts.map((alternatives) => hasFact(run.answer, alternatives));
    record.factRecall = record.factsFound.filter(Boolean).length / question.facts.length;
    record.correct = !record.refused && record.factsFound.every(Boolean);
  } else {
    // A correct refusal: the app's exact sentence and no source shown.
    record.refusedCorrectly = record.refused && cited.length === 0;
  }
  return record;
}

const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
const share = (records, predicate) => (records.length ? records.filter(predicate).length / records.length : null);

/** One table row for a group of scored records (and their questions' types/languages). */
export function summarizeGroup(records) {
  const answerable = records.filter((r) => r.answerable);
  const answered = answerable.filter((r) => !r.errored && !r.noAnswer);
  const unanswerable = records.filter((r) => !r.answerable);
  const answeredNone = unanswerable.filter((r) => !r.errored && !r.noAnswer);
  return {
    answerable: answerable.length,
    unanswerable: unanswerable.length,
    errored: records.filter((r) => r.errored).length,
    retrievalAll: share(answerable, (r) => r.retrievalAll),
    retrievalAny: share(answerable, (r) => r.retrievalAny),
    retrievalTop1: share(answerable, (r) => r.retrievalTop1),
    chance: mean(answerable.map((r) => r.chance).filter((c) => c !== null)),
    chanceTop1: mean(answerable.map((r) => r.chanceTop1).filter((c) => c !== null)),
    citedAll: share(answered, (r) => r.citedAll),
    correct: share(answered, (r) => r.correct),
    factRecall: mean(answered.map((r) => r.factRecall)),
    falseRefusals: answered.filter((r) => r.refused).length,
    answeredCount: answered.length,
    refused: share(answeredNone, (r) => r.refusedCorrectly),
    softRefused: share(answeredNone, (r) => r.softRefused),
    unansweredCount: answeredNone.length,
    topScoreAnswerable: mean(answerable.map((r) => r.topScore).filter((s) => s !== null)),
    topScoreUnanswerable: mean(unanswerable.map((r) => r.topScore).filter((s) => s !== null)),
  };
}

/** Summaries for the slices shown in the README: all, by language, by question type. */
export function summarize(questions, records) {
  const byId = new Map(questions.map((q) => [q.id, q]));
  const slices = {
    all: () => true,
    en: (q) => q.lang === 'en',
    ar: (q) => q.lang === 'ar',
    single: (q) => q.type === 'single',
    'cross-lingual': (q) => q.type === 'cross-lingual',
    multi: (q) => q.type === 'multi',
    unanswerable: (q) => q.type === 'unanswerable',
  };
  return Object.fromEntries(Object.entries(slices).map(([name, keep]) => [name, summarizeGroup(records.filter((r) => keep(byId.get(r.id))))]));
}

/** Latency stats in ms (mean, median, max) over the given numbers. */
export function latencyStats(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return { mean: mean(values), median, max: sorted.at(-1) };
}
